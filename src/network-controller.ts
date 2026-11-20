import { normal, TabStates } from './tab-state.ts'
import type { DocumentIdentity, PreparedMode, SessionStorage, TabEntry } from './tab-state.ts'
import type { ModeChange, PacketOptions, TabState } from './types.ts'
import { errorMessage, isPacketOptions, isRecord, sameOptions } from './utils.ts'

type DebuggerApi = Pick<typeof chrome.debugger, 'attach' | 'sendCommand' | 'detach'>
type StateUpdate = (entry: TabEntry, previous: TabState, signal: AbortSignal) => Promise<TabState>

const RULE_COMMAND = 'Network.emulateNetworkConditionsByRule'
const NATIVE_CONDITIONS = { latency: 0, downloadThroughput: -1, uploadThroughput: -1 }
const NEUTRAL_PACKETS: PacketOptions = { packetLoss: 0, packetReordering: false }
const DOCUMENT_REQUESTS = [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }]

function missingSession(error: unknown): boolean {
  return /^(Debugger is not attached to the tab with id:|No tab with given id )/.test(errorMessage(error))
}

function rootDocument(frame: unknown): DocumentIdentity | undefined {
  if (isRecord(frame) && frame.parentId === undefined
    && typeof frame.id === 'string' && typeof frame.loaderId === 'string') {
    return { frameId: frame.id, loaderId: frame.loaderId }
  }
}

function sameDocument(a: DocumentIdentity, b: DocumentIdentity): boolean {
  return a.frameId === b.frameId && a.loaderId === b.loaderId
}

export class NetworkController {
  readonly #debugger: DebuggerApi
  readonly #states: TabStates
  readonly #publish: (tabId: number, state: TabState) => Promise<void>

  constructor(
    debuggerApi: DebuggerApi,
    storage: SessionStorage,
    publish: (tabId: number, state: TabState) => Promise<void> = async () => {},
  ) {
    this.#debugger = debuggerApi
    this.#states = new TabStates(storage)
    this.#publish = publish
  }

  private attach(tabId: number): Promise<void> {
    return this.#debugger.attach({ tabId }, '1.3')
  }

  prepare(tabId: number): Promise<TabState> {
    return this.#withState(tabId, async (entry, previous, signal) => {
      if (previous.attached !== false) return previous
      let attached = false
      try {
        // Record cleanup before attach so recovery can close an interrupted preparation.
        await this.#states.save(tabId, { kind: 'cleanup', options: previous.options })
        signal.throwIfAborted()
        await this.attach(tabId)
        attached = true
        const document = await this.#watchDocument(tabId, entry, signal)
        if (!document) {
          return this.#cleanup(tabId, normal().options, signal, 'The page changed before WebRTC preparation completed.')
        }
        const plan: PreparedMode = {
          kind: 'prepared', mode: 'normal', options: previous.options, document, clearNavigator: false,
        }
        await this.#states.save(tabId, plan)
        await this.#enableNetwork(tabId, signal)
        return await this.#apply(tabId, plan, signal)
      } catch (error) {
        if (signal.aborted) return previous
        entry.document = undefined
        const message = errorMessage(error)
        if (attached && !missingSession(error)) return this.#cleanup(tabId, previous.options, signal, message)
        return this.#finishNormal(tabId, previous.options, message)
      }
    })
  }

  setNormal(tabId: number): Promise<TabState> {
    return this.#set(tabId, { mode: 'normal' })
  }

  setPacketLoss(tabId: number, options: PacketOptions): Promise<TabState> {
    if (!isPacketOptions(options)) return Promise.reject(new Error('Invalid packet loss options.'))
    return this.#set(tabId, { mode: 'packet-loss', options })
  }

  setOffline(tabId: number): Promise<TabState> {
    return this.#set(tabId, { mode: 'offline' })
  }

  private detach(tabId: number): Promise<void> {
    return this.#debugger.detach({ tabId })
  }

  async restore(): Promise<void> {
    await Promise.all((await this.#states.storedTabs()).map((tabId) => this.getState(tabId)))
  }

  getState(tabId: number): Promise<TabState> {
    return this.#withState(tabId)
  }

  onDetached(tabId: number, reason: 'target_closed' | 'canceled_by_user'): Promise<TabState> {
    const state = normal()
    const error = reason === 'target_closed' ? 'The debugger target closed.' : 'Chrome disconnected the debugger.'
    this.#states.interrupt(tabId, { ...state, error })
    return this.#states.run(tabId, async (entry, signal) => {
      const current = await this.#finishNormal(tabId, state.options, error)
      if (!signal.aborted) {
        entry.state = current
        await this.#publish(tabId, current)
      }
      return entry.state ?? current
    })
  }

  onDebuggerEvent(tabId: number, method: string, params: unknown): Promise<TabState | undefined> | undefined {
    if (method !== 'Fetch.requestPaused' && method !== 'Page.frameNavigated') return
    if (!isRecord(params)) return
    if (method === 'Fetch.requestPaused' && typeof params.requestId === 'string') {
      return this.#onRequestPaused(tabId, params.requestId, params.frameId)
    }
    if (method !== 'Page.frameNavigated') return

    const document = this.#states.find(tabId)?.document
    const next = rootDocument(params.frame)
    if (document && next && !sameDocument(next, document)) return this.#resetDocument(tabId)
  }

  #resetDocument(tabId: number, requestId?: string): Promise<TabState> {
    const initial = normal()
    this.#states.interrupt(tabId, {
      mode: null, attached: null, options: initial.options, error: 'The page is reloading or has navigated.',
    })
    // Detaching clears emulation and lets Chrome resume the navigation it paused.
    const release = requestId === undefined ? undefined : this.#releaseNavigation(tabId, requestId)
    return this.#states.run(tabId, async (entry, signal) => {
      const detachError = await release
      let state = release && !detachError
        ? await this.#finishNormal(tabId, initial.options)
        : await this.#cleanup(tabId, initial.options, signal)
      if (detachError && state.attached === null && state.error !== detachError) {
        state = { ...state, error: [detachError, state.error].filter(Boolean).join(' ') }
      }
      if (!signal.aborted) {
        entry.state = state
        await this.#publish(tabId, state)
      }
      return entry.state ?? state
    })
  }

  async #onRequestPaused(tabId: number, requestId: string, frameId: unknown): Promise<TabState | undefined> {
    const known = this.#states.find(tabId)
    let document = known?.document
    if (!document && !known?.state) {
      // A paused navigation may wake the service worker before restore finishes.
      try {
        const intent = await this.#states.load(tabId)
        const current = this.#states.find(tabId)
        document = current?.document ?? (current?.state || intent?.kind !== 'prepared' ? undefined : intent.document)
      } catch (error) {
        console.warn('Network Chaos could not read the paused document state.', error)
      }
    }
    if (document && frameId === document.frameId) return this.#resetDocument(tabId, requestId)
    await this.#continueRequest(tabId, requestId)
  }

  async #continueRequest(tabId: number, requestId: string): Promise<void> {
    try {
      await this.#send(tabId, 'Fetch.continueRequest', { requestId })
    } catch (error) {
      if (!missingSession(error)) console.warn('Network Chaos could not continue a paused request.', error)
    }
  }

  async #releaseNavigation(tabId: number, requestId: string): Promise<string | undefined> {
    try {
      await this.detach(tabId)
    } catch (error) {
      if (missingSession(error)) return
      // A paused navigation can delay Network.disable. Release it before trying network cleanup.
      try {
        await this.#send(tabId, 'Fetch.disable')
      } catch {
        await this.#continueRequest(tabId, requestId)
      }
      return `Could not detach for navigation: ${errorMessage(error)}`
    }
  }

  onTabRemoved(tabId: number): Promise<void> {
    this.#states.interrupt(tabId, { ...normal(), error: 'The tab closed.' })
    return this.#states.run(tabId, async () => {
      try {
        await this.#states.clear(tabId)
      } finally {
        this.#states.forget(tabId)
      }
    })
  }

  #withState(tabId: number, update?: StateUpdate): Promise<TabState> {
    return this.#states.run(tabId, async (entry, signal) => {
      if (signal.aborted) return entry.state ?? normal()
      // Unknown state can be a pending cleanup. Allow a later request to retry it.
      let previous = entry.state
      if (!previous) previous = await this.#restoreTab(tabId, entry, signal)
      else if (previous.attached === null) previous = await this.#cleanup(tabId, previous.options, signal)
      if (signal.aborted) return entry.state ?? previous
      const state = update ? await update(entry, previous, signal) : previous
      if (signal.aborted) return entry.state ?? state
      if (entry.state !== state) {
        entry.state = state
        await this.#publish(tabId, state)
      }
      return entry.state
    })
  }

  #set(tabId: number, change: ModeChange): Promise<TabState> {
    return this.#withState(tabId, async (entry, previous, signal) => {
      if (previous.attached !== true || !entry.document) {
        if (change.mode === 'normal' || previous.attached === null) return previous
        return { ...previous, error: 'Prepare WebRTC for this tab before changing the network mode.' }
      }
      const options = change.mode === 'packet-loss' ? change.options : previous.options
      if (!previous.error && previous.mode === change.mode && sameOptions(previous.options, options)) return previous

      const plan: PreparedMode = {
        kind: 'prepared', mode: change.mode, options, document: entry.document,
        clearNavigator: previous.mode === 'offline',
      }
      try {
        await this.#states.save(tabId, plan)
      } catch (error) {
        return { ...previous, error: errorMessage(error) }
      }
      try {
        return await this.#apply(tabId, plan, signal)
      } catch (error) {
        if (signal.aborted) return previous
        entry.document = undefined
        const message = errorMessage(error)
        if (missingSession(error)) return this.#finishNormal(tabId, options, message)
        return this.#cleanup(tabId, options, signal, message)
      }
    })
  }

  async #restoreTab(tabId: number, entry: TabEntry, signal: AbortSignal): Promise<TabState> {
    const intent = await this.#states.load(tabId)
    if (!intent || signal.aborted) return normal()
    if (intent.kind === 'prepared') entry.document = intent.document
    await this.#publish(tabId, { mode: null, attached: null, options: intent.options })
    if (intent.kind === 'cleanup') return this.#cleanup(tabId, intent.options, signal)
    try {
      // Commands are scoped to this extension's own CDP client. Recovery never attaches.
      const document = await this.#watchDocument(tabId, entry, signal, intent.document)
      if (!document) return this.#cleanup(tabId, normal().options, signal)
      await this.#enableNetwork(tabId, signal)
      return await this.#apply(tabId, intent, signal)
    } catch (error) {
      if (signal.aborted) return normal()
      entry.document = undefined
      if (missingSession(error)) return this.#finishNormal(tabId, normal().options, errorMessage(error))
      return this.#cleanup(tabId, intent.options, signal, errorMessage(error))
    }
  }

  async #watchDocument(
    tabId: number, entry: TabEntry, signal: AbortSignal, expected?: DocumentIdentity,
  ): Promise<DocumentIdentity | undefined> {
    signal.throwIfAborted()
    const document = expected ?? await this.#readDocument(tabId)
    signal.throwIfAborted()
    entry.document = document
    await this.#send(tabId, 'Page.enable')
    signal.throwIfAborted()
    // Close the gap between reading the initial document and subscribing to its navigation events.
    const current = await this.#readDocument(tabId)
    signal.throwIfAborted()
    if (sameDocument(document, current)) return document
    entry.document = undefined
  }

  async #readDocument(tabId: number): Promise<DocumentIdentity> {
    const result = await this.#send(tabId, 'Page.getFrameTree')
    const tree = isRecord(result) && result.frameTree
    const document = isRecord(tree) && rootDocument(tree.frame)
    if (!document) throw new Error('Chrome did not report the tab’s main document.')
    return document
  }

  async #enableNetwork(tabId: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    // Chromium assigns the throttling token to new UDP and WebSocket connections through this agent.
    await this.#send(tabId, 'Network.enable', {
      maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0,
    })
  }

  async #apply(tabId: number, intent: PreparedMode, signal: AbortSignal): Promise<TabState> {
    signal.throwIfAborted()
    const offline = intent.mode === 'offline'
    if (offline) {
      // Pause Document requests before they hit the Offline rule, so a top-level navigation can reset it.
      await this.#send(tabId, 'Fetch.enable', { patterns: DOCUMENT_REQUESTS })
      signal.throwIfAborted()
    }
    const { packetLoss, packetQueueLength, packetReordering } = intent.mode === 'packet-loss'
      ? intent.options : NEUTRAL_PACKETS
    const conditions = {
      urlPattern: '', offline, ...NATIVE_CONDITIONS,
      packetLoss: offline ? 100 : packetLoss,
      packetReordering,
      ...(packetQueueLength !== undefined ? { packetQueueLength } : {}),
    }
    // Older Chrome requires top-level offline. Current CDP also accepts it alongside the rule field.
    const result = await this.#send(tabId, RULE_COMMAND, {
      offline, matchedNetworkConditions: [conditions],
    })
    if (!result || !('ruleIds' in result) || !Array.isArray(result.ruleIds)
      || result.ruleIds.length !== 1 || typeof result.ruleIds[0] !== 'string') {
      throw new Error('Chrome did not confirm the global network rule.')
    }
    signal.throwIfAborted()
    if (offline || intent.clearNavigator) {
      // Offline false with disabled throughput and latency releases Blink's override.
      await this.#send(tabId, 'Network.overrideNetworkState', { offline, ...NATIVE_CONDITIONS })
    }
    signal.throwIfAborted()
    if (!offline && intent.clearNavigator) await this.#send(tabId, 'Fetch.disable')
    signal.throwIfAborted()
    return { mode: intent.mode, options: intent.options, attached: true }
  }

  async #send(tabId: number, method: string, params?: object): Promise<object | undefined> {
    try {
      return await this.#debugger.sendCommand({ tabId }, method, params)
    } catch (error) {
      if (missingSession(error)) throw error
      throw new Error(`${method}: ${errorMessage(error)}`)
    }
  }

  async #cleanup(tabId: number, options: PacketOptions, signal: AbortSignal, error?: string): Promise<TabState> {
    if (signal.aborted) return normal(options)
    let journalError: string | undefined
    try {
      await this.#states.save(tabId, { kind: 'cleanup', options })
    } catch (cause) {
      journalError = errorMessage(cause)
    }
    try {
      await this.#resetAndDetach(tabId, signal)
    } catch (cause) {
      return {
        mode: null, options, attached: null,
        error: [error, journalError, errorMessage(cause)].filter(Boolean).join(' '),
      }
    }
    if (signal.aborted) return normal(options)
    return this.#finishNormal(tabId, options, error)
  }

  async #disableNetwork(tabId: number): Promise<boolean> {
    try {
      await this.#debugger.sendCommand({ tabId }, 'Network.disable')
      return true
    } catch (error) {
      // Chrome disposes the network overrides with the session even if explicit reset failed.
      return !missingSession(error)
    }
  }

  async #resetAndDetach(tabId: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (!await this.#disableNetwork(tabId)) return
    signal.throwIfAborted()
    try {
      await this.detach(tabId)
    } catch (error) {
      if (missingSession(error)) return
      await this.#send(tabId, 'Fetch.disable').catch(() => {})
      throw new Error(`Could not detach the debugger: ${errorMessage(error)}`)
    }
  }

  async #finishNormal(tabId: number, options: PacketOptions, error?: string): Promise<TabState> {
    try {
      await this.#states.clear(tabId)
    } catch (storageError) {
      const message = `Could not clear the saved session: ${errorMessage(storageError)}`
      return { ...normal(options), error: error ? `${error} ${message}` : message }
    }
    return error ? { ...normal(options), error } : normal(options)
  }
}
