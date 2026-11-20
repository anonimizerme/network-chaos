import { defineBackground } from 'wxt/utils/define-background'
import { NetworkController } from '../src/network-controller.ts'
import type { Request, Response, StateChanged, TabState } from '../src/types.ts'
import { errorMessage, isRequest } from '../src/utils.ts'

async function updateBadge(tabId: number, state: TabState): Promise<void> {
  const text = state.mode === 'offline' ? 'OFF'
    : state.mode === 'packet-loss' ? `${state.options.packetLoss}%`
      : state.mode === null ? (state.error ? '!' : '?') : ''
  try {
    if (text) {
      await chrome.action.setBadgeBackgroundColor({
        tabId, color: state.mode === 'packet-loss' ? '#ae5e0a' : '#a1272d',
      })
    }
    await chrome.action.setBadgeText({ tabId, text })
  } catch (error) {
    console.warn('Network Chaos could not update the badge.', error)
  }
}

export default defineBackground({
  type: 'module',
  main() {
    const controller = new NetworkController(chrome.debugger, chrome.storage.session, updateBadge)

    async function respond(request: Request): Promise<Response> {
      if (request.type === 'get-state') {
        return { ok: true, state: await controller.getState(request.tabId), supportsPrepare: true }
      }
      let state: TabState
      if (request.type === 'prepare') state = await controller.prepare(request.tabId)
      else if (request.mode === 'packet-loss') state = await controller.setPacketLoss(request.tabId, request.options)
      else if (request.mode === 'offline') state = await controller.setOffline(request.tabId)
      else state = await controller.setNormal(request.tabId)
      return state.error ? { ok: false, state, error: state.error } : { ok: true, state }
    }

    chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse: (response: Response) => void) => {
      if (sender.id !== chrome.runtime.id || sender.tab || !isRequest(message)) return false
      respond(message).then(sendResponse, (error) => sendResponse({ ok: false, error: errorMessage(error) }))
      return true
    })

    function reportReset(tabId: number, reset: Promise<TabState | undefined>) {
      void reset.then((state) => {
        if (!state) return
        const message: StateChanged = { type: 'state-changed', tabId, state }
        // The popup may be closed when the page or debugger changes.
        void chrome.runtime.sendMessage(message).catch(() => {})
      }).catch(console.error)
    }

    chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
      if (tabId !== undefined) reportReset(tabId, controller.onDetached(tabId, reason))
    })

    chrome.debugger.onEvent.addListener(({ tabId, sessionId }, method, params) => {
      if (tabId === undefined || sessionId !== undefined) return
      const reset = controller.onDebuggerEvent(tabId, method, params)
      if (reset) reportReset(tabId, reset)
    })

    chrome.tabs.onRemoved.addListener((tabId) => {
      void controller.onTabRemoved(tabId).catch(console.error)
    })

    void controller.restore().catch(console.error)
  },
})
