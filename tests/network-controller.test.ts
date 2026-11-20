import assert from 'node:assert/strict'
import test from 'node:test'
import { NetworkController } from '../src/network-controller.ts'
import type { SessionStorage } from '../src/tab-state.ts'
import type { PacketOptions, TabState } from '../src/types.ts'
import { isRequest } from '../src/utils.ts'

const RULE = 'Network.emulateNetworkConditionsByRule'
const OVERRIDE = 'Network.overrideNetworkState'
const ENABLE = 'Network.enable'
const FRAME_TREE = 'Page.getFrameTree'
const PAGE_ENABLE = 'Page.enable'
const DISABLE = 'Network.disable'
const FETCH_ENABLE = 'Fetch.enable'
const FETCH_DISABLE = 'Fetch.disable'
const FETCH_PAUSED = 'Fetch.requestPaused'
const FETCH_CONTINUE = 'Fetch.continueRequest'
const documentPattern = { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] }
const NATIVE = { latency: 0, downloadThroughput: -1, uploadThroughput: -1 }
const options: PacketOptions = { packetLoss: 25, packetReordering: false }
const neutral: PacketOptions = { packetLoss: 0, packetReordering: false }
const otherOptions: PacketOptions = { packetLoss: 75, packetReordering: true, packetQueueLength: 20 }
const active = (mode: TabState['mode'], settings = options) => ({ mode, attached: true, options: settings })
const idle = () => ({ mode: 'normal', attached: false, options })
const mainFrame = (tabId: number) => ({ id: `main-${tabId}`, loaderId: 'initial' })

function expectedRule(offline: boolean, settings: PacketOptions) {
  return {
    offline,
    matchedNetworkConditions: [{ urlPattern: '', offline, ...NATIVE, ...settings }],
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((finish) => { resolve = finish })
  return { promise, resolve }
}

function mockChrome() {
  const attached = new Set<number>()
  const externalDebugger = new Set<number>()
  const calls: Array<[number, string, object?]> = []
  const published: Array<[number, TabState]> = []
  const frames = new Map<number, ReturnType<typeof mainFrame>>()
  const journal: Record<string, unknown> = {}
  const storage: SessionStorage = {
    async get(key) { return structuredClone(key ? { [key]: journal[key] } : journal) },
    async set(items) { Object.assign(journal, structuredClone(items)) },
    async remove(key) { delete journal[key] },
  }
  function requireAttached(tabId: number): void {
    if (!attached.has(tabId)) throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`)
  }
  const hooks: {
    command?: (tabId: number, method: string) => Promise<void>
    attachError?: Error
    detachError?: Error
  } = {}
  const debuggerApi = {
    async attach({ tabId = 0 }: chrome.debugger.Debuggee, version: string) {
      calls.push([tabId, 'attach', { version }])
      assert.deepEqual(journal[`tab:${tabId}`], { kind: 'cleanup', options })
      if (hooks.attachError) throw hooks.attachError
      if (attached.has(tabId) || externalDebugger.has(tabId)) throw new Error('Another debugger is attached.')
      attached.add(tabId)
    },
    async sendCommand({ tabId = 0 }: chrome.debugger.Debuggee, method: string, params?: object) {
      calls.push(params === undefined ? [tabId, method] : [tabId, method, params])
      requireAttached(tabId)
      await hooks.command?.(tabId, method)
      requireAttached(tabId)
      if (method === FRAME_TREE) return { frameTree: { frame: frames.get(tabId) ?? mainFrame(tabId) } }
      return method === RULE ? { ruleIds: ['id'] } : undefined
    },
    async detach({ tabId = 0 }: chrome.debugger.Debuggee) {
      calls.push([tabId, 'detach'])
      requireAttached(tabId)
      if (hooks.detachError) throw hooks.detachError
      attached.delete(tabId)
    },
  }
  const createController = () => new NetworkController(debuggerApi, storage, async (tabId, state) => {
    published.push([tabId, state])
  })
  return {
    hooks, calls, journal, frames, attached, externalDebugger, published, storage, createController,
    controller: createController(),
  }
}

test('opening the popup never attaches and modes require explicit Prepare', async () => {
  const { controller, calls, journal } = mockChrome()
  assert.deepEqual(await controller.getState(1), idle())
  assert.deepEqual(await controller.setNormal(1), idle())
  assert.match((await controller.setPacketLoss(1, options)).error ?? '', /Prepare WebRTC/)
  assert.match((await controller.setOffline(1)).error ?? '', /Prepare WebRTC/)
  assert.deepEqual(calls, [])
  assert.deepEqual(journal, {})
})

test('Prepare attaches once and confirms neutral Normal while preserving remembered settings', async () => {
  const { controller, calls, journal } = mockChrome()
  assert.deepEqual(await controller.prepare(1), active('normal'))
  assert.deepEqual(await controller.prepare(1), active('normal'))
  assert.deepEqual(await controller.getState(1), active('normal'))
  assert.deepEqual(calls, [
    [1, 'attach', { version: '1.3' }], [1, FRAME_TREE], [1, PAGE_ENABLE], [1, FRAME_TREE],
    [1, ENABLE, { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 }],
    [1, RULE, expectedRule(false, neutral)],
  ])
  assert.deepEqual(journal['tab:1'], {
    kind: 'prepared', mode: 'normal', options, clearNavigator: false,
    document: { frameId: 'main-1', loaderId: 'initial' },
  })
})

test('Packet Loss 25% → 75% updates the same CDP session with all packet settings', async () => {
  const { controller, calls } = mockChrome()
  await controller.prepare(1)
  calls.length = 0
  assert.deepEqual(await controller.setPacketLoss(1, options), active('packet-loss'))
  assert.deepEqual(await controller.setPacketLoss(1, otherOptions), active('packet-loss', otherOptions))
  assert.deepEqual(calls, [[1, RULE, expectedRule(false, options)], [1, RULE, expectedRule(false, otherOptions)]])
})

test('Packet Loss → Offline drops packets and overrides Navigator', async () => {
  const { controller, calls } = mockChrome()
  await controller.prepare(1)
  await controller.setPacketLoss(1, otherOptions)
  calls.length = 0
  assert.deepEqual(await controller.setOffline(1), active('offline', otherOptions))
  assert.deepEqual(calls, [
    [1, FETCH_ENABLE, documentPattern],
    [1, RULE, expectedRule(true, { packetLoss: 100, packetReordering: false })],
    [1, OVERRIDE, { offline: true, ...NATIVE }],
  ])
})

test('Offline → Normal restores native Navigator and neutral limits without detaching or losing remembered settings', async () => {
  const { controller, calls, attached, journal } = mockChrome()
  await controller.prepare(1)
  await controller.setPacketLoss(1, otherOptions)
  await controller.setOffline(1)
  calls.length = 0
  assert.deepEqual(await controller.setNormal(1), active('normal', otherOptions))
  assert.deepEqual(calls, [
    [1, RULE, expectedRule(false, neutral)],
    [1, OVERRIDE, { offline: false, ...NATIVE }],
    [1, FETCH_DISABLE],
  ])
  assert.deepEqual([...attached], [1])
  assert.equal((journal['tab:1'] as { kind: string }).kind, 'prepared')
  assert.deepEqual(await controller.setPacketLoss(1, otherOptions), active('packet-loss', otherOptions))
})

test('Offline → Packet Loss releases the Navigator override without detaching', async () => {
  const { controller, calls } = mockChrome()
  await controller.prepare(1)
  await controller.setOffline(1)
  calls.length = 0
  assert.deepEqual(await controller.setPacketLoss(1, otherOptions), active('packet-loss', otherOptions))
  assert.deepEqual(calls, [
    [1, RULE, expectedRule(false, otherOptions)],
    [1, OVERRIDE, { offline: false, ...NATIVE }],
    [1, FETCH_DISABLE],
  ])
})

test('repeating a confirmed mode with the same settings is idempotent', async () => {
  const { controller, calls } = mockChrome()
  await controller.prepare(1)
  calls.length = 0
  await controller.setNormal(1)
  await controller.setPacketLoss(1, options)
  await controller.setPacketLoss(1, { ...options })
  await controller.setOffline(1)
  await controller.setOffline(1)
  await controller.setNormal(1)
  await controller.setNormal(1)
  assert.deepEqual(calls.map((call) => call[1]), [RULE, FETCH_ENABLE, RULE, OVERRIDE, RULE, OVERRIDE, FETCH_DISABLE])
})

test('attach error leaves Normal unprepared and an explicit retry can succeed', async () => {
  const { controller, hooks, calls, journal, published } = mockChrome()
  hooks.attachError = new Error('Could not attach.')
  const state = await controller.prepare(1)
  assert.deepEqual(state, { ...idle(), error: 'Could not attach.' })
  assert.deepEqual(await controller.getState(1), state)
  assert.deepEqual(calls.map((call) => call[1]), ['attach'])
  assert.deepEqual(journal, {})
  assert.deepEqual(published.at(-1), [1, state])
  delete hooks.attachError
  assert.deepEqual(await controller.prepare(1), active('normal'))
})

test('unexpected debugger detach clears the journal and publishes Normal without reattaching', async () => {
  const { controller, attached, published, journal, calls } = mockChrome()
  await controller.prepare(1)
  await controller.setPacketLoss(1, otherOptions)
  calls.length = 0
  attached.delete(1)
  const state = await controller.onDetached(1, 'canceled_by_user')
  assert.deepEqual(state, { ...idle(), error: 'Chrome disconnected the debugger.' })
  assert.deepEqual(await controller.getState(1), state)
  assert.deepEqual(published.at(-1), [1, state])
  assert.deepEqual(journal, {})
  assert.deepEqual(calls, [])
})

test('detach interrupts in-flight and queued changes', async () => {
  const { controller, attached, calls, hooks, journal } = mockChrome()
  await controller.prepare(1)
  calls.length = 0
  const entered = deferred()
  const release = deferred()
  hooks.command = async (_tabId, method) => {
    if (method === RULE) {
      entered.resolve()
      await release.promise
    }
  }
  const running = controller.setOffline(1)
  await entered.promise
  const queued = controller.setPacketLoss(1, otherOptions)
  attached.delete(1)
  const detached = controller.onDetached(1, 'canceled_by_user')
  release.resolve()
  for (const state of await Promise.all([running, queued, detached])) {
    assert.deepEqual(state, { ...idle(), error: 'Chrome disconnected the debugger.' })
  }
  assert.deepEqual(calls.map((call) => call[1]), [FETCH_ENABLE, RULE])
  assert.deepEqual(journal, {})
})

test('closing a tab clears only its stored and in-memory state', async () => {
  const { controller, attached, journal } = mockChrome()
  await controller.prepare(1)
  await controller.setPacketLoss(1, otherOptions)
  await controller.prepare(2)
  attached.delete(1)
  await controller.onTabRemoved(1)
  assert.equal(journal['tab:1'], undefined)
  assert.deepEqual(await controller.getState(1), idle())
  assert.deepEqual(await controller.getState(2), active('normal'))
  assert.deepEqual([...attached], [2])
})

test('operations serialize per tab and do not block operations for other prepared tabs', async () => {
  const { controller, hooks, calls } = mockChrome()
  await controller.prepare(1)
  await controller.prepare(2)
  calls.length = 0
  const entered = deferred()
  const release = deferred()
  hooks.command = async (tabId, method) => {
    if (tabId === 1 && method === RULE) {
      entered.resolve()
      await release.promise
    }
  }
  const first = controller.setPacketLoss(1, options)
  await entered.promise
  const next = controller.setPacketLoss(1, otherOptions)
  try {
    assert.deepEqual(await controller.setOffline(2), active('offline'))
    assert.equal(calls.filter(([tabId, method]) => tabId === 1 && method === RULE).length, 1)
  } finally {
    release.resolve()
  }
  assert.deepEqual(await first, active('packet-loss'))
  assert.deepEqual(await next, active('packet-loss', otherOptions))
})

test('same-document activity, repeat commit, and subframe navigation keep the prepared document', async () => {
  const { controller, calls, attached } = mockChrome()
  await controller.prepare(1)
  await controller.setOffline(1)
  calls.length = 0
  assert.equal(controller.onDebuggerEvent(1, 'Page.navigatedWithinDocument', {
    frameId: 'main-1', url: 'https://example.com/#section',
  }), undefined)
  assert.equal(controller.onDebuggerEvent(1, 'Page.frameStartedNavigating', {
    frameId: 'main-1', loaderId: 'provisional', navigationType: 'sameDocument',
  }), undefined)
  assert.equal(controller.onDebuggerEvent(1, 'Page.frameStartedNavigating', {
    frameId: 'main-1', loaderId: 'initial', navigationType: 'reload',
  }), undefined)
  assert.equal(controller.onDebuggerEvent(1, 'Page.frameStartedNavigating', {
    frameId: 'subframe', navigationType: 'reload',
  }), undefined)
  assert.equal(controller.onDebuggerEvent(1, 'Page.frameNavigated', { frame: mainFrame(1) }), undefined)
  assert.equal(controller.onDebuggerEvent(1, 'Page.frameNavigated', {
    frame: { id: 'subframe', loaderId: 'new', parentId: 'main-1' },
  }), undefined)
  assert.deepEqual(await controller.getState(1), active('offline'))
  assert.deepEqual([...attached], [1])
  assert.deepEqual(calls, [])
})

test('a paused Offline main navigation detaches immediately and resets only its prepared state', async () => {
  const { controller, calls, journal, attached } = mockChrome()
  await controller.prepare(1)
  await controller.setOffline(1)
  await controller.prepare(2)
  calls.length = 0
  const reload = controller.onDebuggerEvent(1, FETCH_PAUSED, { frameId: 'main-1', requestId: 'nav' })
  assert.ok(reload)
  assert.deepEqual(calls, [[1, 'detach']], 'release the request before waiting for storage')
  assert.deepEqual(await reload, idle())
  assert.deepEqual(calls, [[1, 'detach']])
  assert.equal(journal['tab:1'], undefined)
  assert.deepEqual([...attached], [2])
  assert.deepEqual(await controller.getState(2), active('normal'))
})

test('a paused subframe request continues unchanged and keeps Offline active', async () => {
  const { controller, calls } = mockChrome()
  await controller.prepare(1)
  await controller.setOffline(1)
  calls.length = 0
  assert.equal(await controller.onDebuggerEvent(1, FETCH_PAUSED, {
    frameId: 'subframe', requestId: 'sub',
  }), undefined)
  assert.deepEqual(calls, [[1, FETCH_CONTINUE, { requestId: 'sub' }]])
  assert.deepEqual(await controller.getState(1), active('offline'))
})

test('a paused navigation can wake a worker and reset the journal without reapplying Offline', async () => {
  const { controller, calls, journal, createController } = mockChrome()
  await controller.prepare(1)
  await controller.setOffline(1)
  calls.length = 0
  const restarted = createController()
  assert.deepEqual(await restarted.onDebuggerEvent(1, FETCH_PAUSED, {
    frameId: 'main-1', requestId: 'nav',
  }), idle())
  assert.deepEqual(await restarted.getState(1), idle())
  assert.deepEqual(calls, [[1, 'detach']])
  assert.deepEqual(journal, {})
})

test('a failed immediate detach releases the navigation and keeps cleanup recoverable', async () => {
  const { controller, calls, hooks, journal } = mockChrome()
  await controller.prepare(1)
  await controller.setOffline(1)
  hooks.detachError = new Error('Detach failed.')
  hooks.command = async (_tabId, method) => {
    if (method === FETCH_DISABLE) throw new Error('Fetch disable failed.')
  }
  calls.length = 0
  const result = await controller.onDebuggerEvent(1, FETCH_PAUSED, {
    frameId: 'main-1', requestId: 'nav',
  })
  assert.equal(result?.mode, null)
  assert.match(result?.error ?? '', /Could not detach for navigation: Detach failed/)
  assert.deepEqual(calls.slice(0, 4), [[1, 'detach'], [1, FETCH_DISABLE], [1, FETCH_CONTINUE, { requestId: 'nav' }], [1, DISABLE]])
  assert.deepEqual(journal['tab:1'], { kind: 'cleanup', options })

  delete hooks.detachError
  assert.deepEqual(await controller.getState(1), idle())
})

test('committing a new main document resets prepared state, even for a Chrome error page', async () => {
  const { controller, calls, journal } = mockChrome()
  await controller.prepare(1)
  await controller.setPacketLoss(1, otherOptions)
  calls.length = 0
  assert.deepEqual(await controller.onDebuggerEvent(1, 'Page.frameNavigated', {
    frame: { id: 'new-main', loaderId: 'new', url: 'chrome-error://chromewebdata/' },
  }), idle())
  assert.deepEqual(calls, [[1, DISABLE], [1, 'detach']])
  assert.deepEqual(await controller.getState(1), idle())
  assert.deepEqual(journal, {})
})

test('an initial Page.enable event for the current frame does not interrupt Prepare', async () => {
  const { controller, hooks } = mockChrome()
  hooks.command = async (tabId, method) => {
    if (method === PAGE_ENABLE) {
      assert.equal(controller.onDebuggerEvent(tabId, 'Page.frameNavigated', { frame: mainFrame(tabId) }), undefined)
    }
  }
  assert.deepEqual(await controller.prepare(1), active('normal'))
})

test('changing documents during Page.enable cancels Prepare before network commands', async () => {
  const { controller, calls, frames, hooks, journal } = mockChrome()
  hooks.command = async (tabId, method) => {
    if (method === PAGE_ENABLE) frames.set(tabId, { id: 'new-main', loaderId: 'new' })
  }
  assert.deepEqual(await controller.prepare(1), { ...idle(), error: 'The page changed before WebRTC preparation completed.' })
  assert.deepEqual(calls.map((call) => call[1]), ['attach', FRAME_TREE, PAGE_ENABLE, FRAME_TREE, DISABLE, 'detach'])
  assert.deepEqual(journal, {})
})

test('navigation interrupts preparation and queued changes before they can apply to the new document', async () => {
  const { controller, calls, hooks, journal } = mockChrome()
  const entered = deferred()
  const release = deferred()
  hooks.command = async (_tabId, method) => {
    if (method === ENABLE) {
      entered.resolve()
      await release.promise
    }
  }
  const preparing = controller.prepare(1)
  await entered.promise
  const queued = controller.setOffline(1)
  const navigation = controller.onDebuggerEvent(1, 'Page.frameNavigated', {
    frame: { ...mainFrame(1), loaderId: 'replacement' },
  })
  assert.ok(navigation)
  release.resolve()
  const [prepareState, queuedState, resetState] = await Promise.all([preparing, queued, navigation])
  assert.match(prepareState.error ?? '', /page is reloading or has navigated/)
  assert.match(queuedState.error ?? '', /page is reloading or has navigated/)
  assert.deepEqual(resetState, idle())
  assert.deepEqual(calls.map((call) => call[1]), ['attach', FRAME_TREE, PAGE_ENABLE, FRAME_TREE, ENABLE, DISABLE, 'detach'])
  assert.deepEqual(journal, {})
})

test('worker restart revalidates a prepared Normal state before publishing it', async () => {
  const { controller, calls, published, createController, hooks } = mockChrome()
  await controller.prepare(1)
  calls.length = 0
  published.length = 0
  const restarted = createController()
  const entered = deferred()
  const release = deferred()
  hooks.command = async (_tabId, method) => {
    if (method === RULE) {
      entered.resolve()
      await release.promise
    }
  }
  const recovery = restarted.restore()
  await entered.promise
  try {
    assert.equal(published.at(-1)?.[1].attached, null)
  } finally {
    release.resolve()
  }
  await recovery
  assert.deepEqual(await restarted.getState(1), active('normal'))
  assert.deepEqual(calls.map((call) => call[1]), [PAGE_ENABLE, FRAME_TREE, ENABLE, RULE])
})

test('worker restart with a different loader detaches and never reapplies previous settings', async () => {
  const { controller, calls, frames, journal, attached, createController } = mockChrome()
  await controller.prepare(1)
  await controller.setOffline(1)
  frames.set(1, { ...mainFrame(1), loaderId: 'new' })
  calls.length = 0
  const restarted = createController()
  await restarted.restore()
  assert.deepEqual(await restarted.getState(1), idle())
  assert.deepEqual(calls.map((call) => call[1]), [PAGE_ENABLE, FRAME_TREE, DISABLE, 'detach'])
  assert.deepEqual(journal, {})
  assert.deepEqual([...attached], [])
})

test('worker restart does not take over a disappeared session or another debugger', async () => {
  const { controller, calls, attached, journal, externalDebugger, createController } = mockChrome()
  await controller.prepare(1)
  await controller.setOffline(1)
  attached.delete(1)
  externalDebugger.add(1)
  calls.length = 0
  const restarted = createController()
  await restarted.restore()
  assert.match((await restarted.getState(1)).error ?? '', /Debugger is not attached/)
  assert.equal(journal['tab:1'], undefined)
  assert.equal(externalDebugger.has(1), true)
  assert.deepEqual(calls.map((call) => call[1]), [PAGE_ENABLE])
})

test('legacy Normal cleanup and new prepared Normal restore differently', async () => {
  const { controller, calls, journal, createController } = mockChrome()
  await controller.prepare(1)
  await controller.prepare(2)
  journal['tab:1'] = { mode: 'normal', options, clearNavigator: false }
  calls.length = 0
  const restarted = createController()
  await restarted.restore()
  assert.deepEqual(await restarted.getState(1), idle())
  assert.deepEqual(await restarted.getState(2), active('normal'))
  assert.deepEqual(calls.filter(([id]) => id === 1).map((call) => call[1]), [DISABLE, 'detach'])
  assert.deepEqual(calls.filter(([id]) => id === 2).map((call) => call[1]), [PAGE_ENABLE, FRAME_TREE, ENABLE, RULE])
})

test('a failed navigation detach remains unconfirmed and explicit Prepare retries cleanup before reattaching', async () => {
  const { controller, calls, hooks, journal, published } = mockChrome()
  await controller.prepare(1)
  hooks.detachError = new Error('Detach failed.')
  const pending = await controller.onDebuggerEvent(1, 'Page.frameNavigated', {
    frame: { ...mainFrame(1), loaderId: 'replacement' },
  })
  assert.equal(pending?.mode, null)
  assert.equal(pending?.attached, null)
  assert.match(pending?.error ?? '', /Detach failed/)
  assert.deepEqual(published.at(-1), [1, pending])
  assert.deepEqual(journal['tab:1'], { kind: 'cleanup', options })

  delete hooks.detachError
  calls.length = 0
  assert.deepEqual(await controller.prepare(1), active('normal'))
  assert.deepEqual(calls.map((call) => call[1]), [DISABLE, 'detach', 'attach', FRAME_TREE, PAGE_ENABLE, FRAME_TREE, ENABLE, RULE])
})

test('unknown state retries cleanup instead of replaying an older journal after a storage write failure', async () => {
  const { controller, calls, hooks, storage } = mockChrome()
  await controller.prepare(1)
  await controller.setOffline(1)
  const save = storage.set
  storage.set = async () => { throw new Error('Could not write journal.') }
  hooks.detachError = new Error('Detach failed.')
  const pending = await controller.onDebuggerEvent(1, 'Page.frameNavigated', {
    frame: { ...mainFrame(1), loaderId: 'replacement' },
  })
  assert.equal(pending?.mode, null)
  assert.match(pending?.error ?? '', /Could not write journal.*Detach failed/)

  storage.set = save
  delete hooks.detachError
  calls.length = 0
  assert.deepEqual(await controller.getState(1), idle())
  assert.deepEqual(calls, [[1, DISABLE], [1, 'detach']])
})

test('a rejected CDP command rolls back and disarms partial Offline emulation', async () => {
  const { controller, hooks, calls, attached, published } = mockChrome()
  await controller.prepare(1)
  hooks.command = async (_tabId, method) => {
    if (method === OVERRIDE) throw new Error('Method not found.')
  }
  const state = await controller.setOffline(1)
  assert.equal(state.mode, 'normal')
  assert.equal(state.attached, false)
  assert.match(state.error ?? '', /Network\.overrideNetworkState: Method not found/)
  assert.equal(attached.size, 0)
  assert.deepEqual(calls.slice(-2), [[1, DISABLE], [1, 'detach']])
  assert.equal(published.some(([, update]) => update.mode === 'offline'), false)
})

test('runtime message validation accepts Prepare and the full CDP queue length range', async () => {
  const message = { type: 'set-mode', mode: 'packet-loss', tabId: 1 }
  assert.equal(isRequest({ type: 'prepare', tabId: 1 }), true)
  assert.equal(isRequest({ type: 'prepare', tabId: -1 }), false)
  assert.equal(isRequest({ ...message, options: { ...options, packetQueueLength: 2_147_483_647 } }), true)
  assert.equal(isRequest({ ...message, options: { ...options, packetQueueLength: 2_147_483_648 } }), false)
  assert.equal(isRequest({ ...message, options: { ...options, packetLoss: 1.5 } }), false)
  assert.equal(isRequest({ ...message, options: { ...options, packetReordering: 1 } }), false)
  assert.equal(isRequest({ ...message, tabId: -1, options }), false)
  const { controller, calls } = mockChrome()
  await assert.rejects(controller.setPacketLoss(1, { ...options, packetLoss: -1 }), /Invalid/)
  assert.deepEqual(calls, [])
})
