import assert from 'node:assert/strict'
import test from 'node:test'
import background from '../entrypoints/background.ts'
import type { Request, Response } from '../src/types.ts'

type Sender = { id: string; tab?: { id: number } }
type Listener = (message: unknown, sender: Sender, reply: (response: Response) => void) => boolean

test('the action popup can check Prepare support and request preparation', { timeout: 1000 }, async (t) => {
  let receive!: Listener
  let attaches = 0
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome')
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      runtime: {
        id: 'network-chaos',
        onMessage: { addListener(listener: Listener) { receive = listener } },
      },
      debugger: {
        onDetach: { addListener() {} },
        onEvent: { addListener() {} },
        async attach() {
          attaches++
          throw new Error('Test debugger unavailable.')
        },
      },
      tabs: { onRemoved: { addListener() {} } },
      storage: { session: { async get() { return {} }, async set() {}, async remove() {} } },
      action: { async setBadgeText() {} },
    },
  })
  t.after(() => {
    if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome)
    else Reflect.deleteProperty(globalThis, 'chrome')
  })
  background.main()

  const popup = { id: 'network-chaos' }
  function send(message: Request): Promise<Response> {
    return new Promise((resolve) => assert.equal(receive(message, popup, resolve), true))
  }

  const status = await send({ type: 'get-state', tabId: 17 })
  assert.equal(status.ok && status.supportsPrepare, true)
  assert.equal(status.state?.attached, false)
  assert.equal(attaches, 0)

  const prepare: Request = { type: 'prepare', tabId: 17 }
  const unexpected = () => assert.fail('A page with no action popup should not receive a response')
  assert.equal(receive(prepare, { id: 'different-extension' }, unexpected), false)
  assert.equal(receive(prepare, { ...popup, tab: { id: 17 } }, unexpected), false)
  assert.equal(attaches, 0)
  assert.deepEqual(await send(prepare), {
    ok: false,
    error: 'Test debugger unavailable.',
    state: {
      mode: 'normal', attached: false, options: { packetLoss: 25, packetReordering: false },
      error: 'Test debugger unavailable.',
    },
  })
  assert.equal(attaches, 1)
})
