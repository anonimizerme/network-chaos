import type { Mode, ModeChange, PacketOptions, Request, Response, StateChanged, TabState } from './types.ts'
import { errorMessage, isTabId, sameOptions } from './utils.ts'
import './popup.css'

const picker = document.querySelector<HTMLFieldSetElement>('#mode-picker')!
const modes = picker.querySelectorAll<HTMLInputElement>('input[name="mode"]')
const preparePanel = document.querySelector<HTMLElement>('#prepare-panel')!
const prepare = document.querySelector<HTMLButtonElement>('#prepare-webrtc')!
const prepareHint = document.querySelector<HTMLElement>('#prepare-hint')!
const reloadPanel = document.querySelector<HTMLElement>('#reload-panel')!
const reloadExtension = document.querySelector<HTMLButtonElement>('#reload-extension')!
const packetPanel = document.querySelector<HTMLFieldSetElement>('#packet-options')!
const offlinePanel = document.querySelector<HTMLElement>('#offline-info')!
const title = document.querySelector<HTMLElement>('#tab-title')!
const connection = document.querySelector<HTMLElement>('#connection')!
const loss = document.querySelector<HTMLInputElement>('#loss')!
const lossValue = document.querySelector<HTMLOutputElement>('#loss-value')!
const reordering = document.querySelector<HTMLInputElement>('#reordering')!
const queueLength = document.querySelector<HTMLInputElement>('#queue-length')!
const errorNotice = document.querySelector<HTMLElement>('#error')!

type Mutation = Exclude<Request, { type: 'get-state' }>
type ReloadRequired = { ok: false; error: string; state?: undefined; reloadRequired: true }
type Reply = Response | ReloadRequired
const unavailable: ReloadRequired = {
  ok: false,
  error: 'The Network Chaos background did not respond.',
  reloadRequired: true,
}
let background: 'checking' | 'ready' | 'reload' = 'checking'
let tabId: number | undefined
let confirmed: TabState | undefined
let error: string | undefined
let pending: Mutation | undefined
let lastSent: Mutation | undefined
let sending = 0
let sentCount = 0
let receivedCount = 0
let pushRevision = 0

function setPacketInputs(options: PacketOptions) {
  loss.value = String(options.packetLoss)
  reordering.checked = options.packetReordering
  queueLength.value = options.packetQueueLength?.toString() ?? ''
}

function renderLoss() {
  const value = `${loss.value}%`
  lossValue.value = value
  loss.style.setProperty('--loss', value)
  loss.setAttribute('aria-valuetext', value)
}

function render(syncOptions = false) {
  const attached = background === 'ready' ? confirmed?.attached : undefined
  const status = attached === true ? 'attached' : attached === false ? 'detached' : 'unknown'
  if (connection.dataset.state !== status) {
    connection.dataset.state = status
    connection.textContent = `CDP ${status}`
  }

  const known = attached != null && confirmed?.mode != null
  const ready = known && attached === true
  const change = pending?.type === 'set-mode' ? pending : undefined
  const selected = known ? (ready ? change?.mode ?? confirmed?.mode : confirmed?.mode) : undefined
  picker.disabled = !known || (Boolean(pending) && !ready)
  modes.forEach((mode) => {
    mode.checked = selected === mode.value
    mode.disabled = mode.value !== 'normal' && !ready
  })
  const retry = background === 'ready' && !known && Boolean(error) && tabId !== undefined
  preparePanel.hidden = background !== 'ready' || (!retry && (confirmed?.mode !== 'normal' || attached !== false))
  prepare.textContent = retry ? 'Retry preparation' : 'Prepare'
  prepareHint.textContent = retry
    ? 'Retry to check the debugger and prepare this tab.'
    : 'Prepare this tab before either participant starts the call. Then choose Packet Loss or Offline.'
  prepare.disabled = Boolean(pending)
  packetPanel.hidden = packetPanel.disabled = !ready || selected !== 'packet-loss'
  offlinePanel.hidden = !ready || selected !== 'offline' || confirmed?.mode !== 'offline'
  if (syncOptions && confirmed) setPacketInputs(confirmed.options)
  renderLoss()

  errorNotice.hidden = !error
  errorNotice.textContent = error ?? ''
  reloadPanel.hidden = background !== 'reload'
}

async function request(message: Request): Promise<Reply> {
  try {
    const response: Response | undefined = await chrome.runtime.sendMessage(message)
    if (!response) return unavailable
    if (message.type === 'get-state' && response.ok && response.supportsPrepare !== true) {
      return { ok: false, error: 'The Network Chaos background is out of date.', reloadRequired: true }
    }
    return response
  } catch (cause) {
    console.warn('Network Chaos could not reach its background.', cause)
    return unavailable
  }
}

function accept(response: Reply) {
  background = 'reloadRequired' in response ? 'reload' : 'ready'
  confirmed = response.state
  error = response.ok ? response.state.error : response.error
}

function sendPending(flush = false) {
  // Flush committed edits without waiting for a reply the popup might never receive.
  if (!pending || lastSent === pending || (sending && !flush)) return
  lastSent = pending
  sending++
  void apply(pending, ++sentCount)
}

async function apply(change: Mutation, sequence: number) {
  let revision = pushRevision
  let response = await request(change)
  // A detach notification can arrive before an older apply response.
  if (revision !== pushRevision && pending === change) {
    revision = pushRevision
    response = await request({ type: 'get-state', tabId: change.tabId })
  } else if (change.type === 'prepare' && !response.ok && !response.state) {
    // A lost response does not tell us whether Chrome has already attached.
    const status = await request({ type: 'get-state', tabId: change.tabId })
    if ('reloadRequired' in status || status.state?.attached === true) response = status
    else if (!('reloadRequired' in response)) response = { ...response, state: status.state }
  }
  sending--

  if (sequence > receivedCount) {
    receivedCount = sequence
    if (revision === pushRevision) accept(response)
    const settled = pending === change
    if (settled) pending = undefined
    const optionsChanged = change.type === 'prepare' || change.mode !== 'packet-loss'
      || (confirmed !== undefined && !sameOptions(change.options, confirmed.options))
    render(settled && optionsChanged)
    if (settled && change.type === 'prepare') {
      const nextFocus = !reloadPanel.hidden ? reloadExtension
        : preparePanel.hidden ? picker.querySelector<HTMLInputElement>('input:checked') : prepare
      nextFocus?.focus()
    }
  }
  sendPending()
}

function choose(change: ModeChange | { type: 'prepare' }, flush: boolean) {
  if (tabId === undefined || background !== 'ready') return
  pending = 'mode' in change ? { type: 'set-mode', tabId, ...change } : { ...change, tabId }
  render()
  sendPending(flush)
}

function packetOptions(): PacketOptions {
  const previous = pending?.type === 'set-mode' && pending.mode === 'packet-loss' ? pending.options : confirmed?.options
  return {
    packetLoss: loss.valueAsNumber,
    packetReordering: reordering.checked,
    packetQueueLength: queueLength.validity.valid
      ? (queueLength.value === '' ? undefined : queueLength.valueAsNumber)
      : previous?.packetQueueLength,
  }
}

function editOptions(flush = false) {
  renderLoss()
  if (packetPanel.disabled) return
  const options = packetOptions()
  const previous = pending?.type === 'set-mode' && pending.mode === 'packet-loss' ? pending.options : confirmed?.options
  if (!previous || !sameOptions(options, previous)) {
    choose({ mode: 'packet-loss', options }, flush)
  } else if (flush) {
    sendPending(true)
  }
}

picker.addEventListener('change', (event) => {
  const mode = (event.target as HTMLInputElement).value as Mode
  choose(mode === 'packet-loss' ? { mode, options: packetOptions() } : { mode }, true)
})

prepare.addEventListener('click', () => choose({ type: 'prepare' }, true))

reloadExtension.addEventListener('click', () => {
  reloadExtension.disabled = true
  try {
    chrome.runtime.reload()
  } catch {
    error = 'Open chrome://extensions and click Reload on the Network Chaos card.'
    reloadExtension.disabled = false
    render()
  }
})

loss.addEventListener('input', () => editOptions())
loss.addEventListener('change', () => editOptions(true))
reordering.addEventListener('change', () => editOptions(true))
queueLength.addEventListener('input', () => {
  if (queueLength.validity.valid) editOptions()
})
queueLength.addEventListener('change', () => {
  if (queueLength.reportValidity()) editOptions(true)
})
window.addEventListener('pagehide', () => sendPending(true))

chrome.runtime.onMessage.addListener((message: StateChanged) => {
  if (background === 'reload' || message.type !== 'state-changed' || message.tabId !== tabId) return
  pushRevision++
  confirmed = message.state
  error = confirmed.error
  // A queued edit for the detached session must not start a new one.
  if (confirmed.attached !== true && pending && pending !== lastSent) pending = undefined
  render(!pending)
})

async function init() {
  try {
    if (await chrome.tabs.getCurrent()) {
      title.textContent = 'Open from the toolbar'
      error = 'Select the tab you want to test, then open Network Chaos from the Chrome toolbar.'
      render()
      return
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!isTabId(tab?.id)) throw new Error('No active tab found.')
    tabId = tab.id
    title.textContent = tab.title || `Tab ${tabId}`
    title.title = title.textContent
    const revision = pushRevision
    const response = await request({ type: 'get-state', tabId })
    if (revision === pushRevision || 'reloadRequired' in response) accept(response)
    else background = 'ready'
  } catch (cause) {
    title.textContent = 'Active tab unavailable'
    error = `${errorMessage(cause)} Reopen the popup on the tab to retry.`
  }
  render(true)
}

void init()
