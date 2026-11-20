import type { PacketOptions, Request } from './types.ts'

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isTabId(id: unknown): id is number {
  return typeof id === 'number' && Number.isSafeInteger(id) && id >= 0
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isPacketOptions(value: unknown): value is PacketOptions {
  if (!isRecord(value)) return false
  const { packetLoss, packetReordering, packetQueueLength } = value
  return typeof packetLoss === 'number'
    && Number.isInteger(packetLoss) && packetLoss >= 0 && packetLoss <= 100
    && typeof packetReordering === 'boolean'
    && (packetQueueLength === undefined || (
      typeof packetQueueLength === 'number' && Number.isInteger(packetQueueLength)
      && packetQueueLength >= 0 && packetQueueLength <= 2_147_483_647
    ))
}

export function isRequest(value: unknown): value is Request {
  if (!isRecord(value) || !isTabId(value.tabId)) return false
  if (value.type === 'get-state' || value.type === 'prepare') return true
  return value.type === 'set-mode' && (
    value.mode === 'normal' || value.mode === 'offline'
    || (value.mode === 'packet-loss' && isPacketOptions(value.options))
  )
}

export function sameOptions(a: PacketOptions, b: PacketOptions): boolean {
  return a.packetLoss === b.packetLoss && a.packetReordering === b.packetReordering
    && a.packetQueueLength === b.packetQueueLength
}
