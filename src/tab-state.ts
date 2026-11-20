import type { Mode, PacketOptions, TabState } from './types.ts'
import { isPacketOptions, isRecord, isTabId } from './utils.ts'

const TAB_KEY = 'tab:'
const defaultOptions = { packetLoss: 25, packetReordering: false }

export interface DocumentIdentity {
  frameId: string
  loaderId: string
}

export interface PreparedMode {
  kind: 'prepared'
  document: DocumentIdentity
  mode: Mode
  options: PacketOptions
  clearNavigator: boolean
}

type SessionIntent = PreparedMode | { kind: 'cleanup'; options: PacketOptions }

export interface SessionStorage {
  get(keys?: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(key: string): Promise<void>
}

export interface TabEntry {
  tail: Promise<void>
  epoch: AbortController
  state?: TabState
  document?: DocumentIdentity
}

export function normal(options = { ...defaultOptions }): TabState {
  return { mode: 'normal', attached: false, options }
}

function readIntent(value: unknown): SessionIntent | undefined {
  if (!isRecord(value) || !isPacketOptions(value.options)) return undefined
  const { kind, mode, document, options, clearNavigator } = value
  if (kind === 'prepared' && (mode === 'normal' || mode === 'packet-loss' || mode === 'offline')
    && isRecord(document) && typeof document.frameId === 'string' && typeof document.loaderId === 'string'
    && typeof clearNavigator === 'boolean') {
    return { kind, mode, document: { frameId: document.frameId, loaderId: document.loaderId }, options, clearNavigator }
  }
  // A pre-upgrade journal cannot prove which document owns the debugger.
  return { kind: 'cleanup', options }
}

export class TabStates {
  readonly #entries = new Map<number, TabEntry>()
  readonly #storage: SessionStorage

  constructor(storage: SessionStorage) {
    this.#storage = storage
  }

  #entry(tabId: number): TabEntry {
    let entry = this.#entries.get(tabId)
    if (!entry) {
      entry = { tail: Promise.resolve(), epoch: new AbortController() }
      this.#entries.set(tabId, entry)
    }
    return entry
  }

  run<T>(tabId: number, task: (entry: TabEntry, signal: AbortSignal) => Promise<T>): Promise<T> {
    const entry = this.#entry(tabId)
    const { signal } = entry.epoch
    const result = entry.tail.then(() => task(entry, signal))
    entry.tail = result.then(() => {}, () => {})
    return result
  }

  interrupt(tabId: number, state: TabState): void {
    const entry = this.#entry(tabId)
    entry.epoch.abort()
    entry.epoch = new AbortController()
    entry.document = undefined
    entry.state = state
  }

  find(tabId: number): TabEntry | undefined {
    return this.#entries.get(tabId)
  }

  forget(tabId: number): void {
    this.#entries.delete(tabId)
  }

  async storedTabs(): Promise<number[]> {
    return Object.keys(await this.#storage.get())
      .filter((key) => key.startsWith(TAB_KEY))
      .map((key) => Number(key.slice(TAB_KEY.length)))
      .filter(isTabId)
  }

  async load(tabId: number): Promise<SessionIntent | undefined> {
    const key = TAB_KEY + tabId
    const intent = (await this.#storage.get(key))[key]
    return readIntent(intent)
  }

  save(tabId: number, intent: SessionIntent): Promise<void> {
    return this.#storage.set({ [TAB_KEY + tabId]: intent })
  }

  clear(tabId: number): Promise<void> {
    return this.#storage.remove(TAB_KEY + tabId)
  }
}
