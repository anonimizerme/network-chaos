export type Mode = 'normal' | 'packet-loss' | 'offline'

export interface PacketOptions {
  packetLoss: number
  packetReordering: boolean
  packetQueueLength?: number
}

export interface TabState {
  mode: Mode | null
  attached: boolean | null
  options: PacketOptions
  error?: string
}

export type ModeChange =
  | { mode: 'normal' | 'offline' }
  | { mode: 'packet-loss'; options: PacketOptions }

export type Request =
  | { type: 'get-state'; tabId: number }
  | { type: 'prepare'; tabId: number }
  | ({ type: 'set-mode'; tabId: number } & ModeChange)

export type Response =
  | { ok: true; state: TabState; supportsPrepare?: true }
  | { ok: false; error: string; state?: TabState }

export interface StateChanged {
  type: 'state-changed'
  tabId: number
  state: TabState
}
