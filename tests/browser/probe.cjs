const assert = require('node:assert/strict')
const { readFile, mkdtemp, rm } = require('node:fs/promises')
const { createServer } = require('node:http')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { setTimeout: wait } = require('node:timers/promises')
const { pathToFileURL } = require('node:url')
const { chromium } = require('playwright')
const { WebSocketServer } = require('ws')

const root = resolve(__dirname, '../..')
const diagnostics = join(root, 'diagnostics')
const extensionDir = join(root, 'dist')

async function waitForRtp(page) {
  await page.waitForFunction(() => {
    const deltas = document.querySelectorAll('[data-stat="deltaReceived"]')
    return deltas.length === 2 && [...deltas].every((cell) => Number(cell.textContent) > 0)
  }, null, { timeout: 15_000 })
}

async function readStats(page) {
  return page.evaluate(() => {
    const readRows = (selector) => [...document.querySelectorAll(selector)].map((row) => {
      return Object.fromEntries([...row.querySelectorAll('[data-stat]')].map((cell) => {
        const value = cell.textContent
        return [cell.dataset.stat, value === '—' ? null : isNaN(Number(value)) ? value : Number(value)]
      }))
    })
    return {
      navigatorOnline: navigator.onLine,
      rtp: readRows('[data-flow]'),
      peers: readRows('[data-peer]'),
      rtcLifecycle: window.rtcLifecycle,
      websocket: {
        status: document.querySelector('#websocket-status').textContent,
        sent: Number(document.querySelector('#websocket-sent').textContent),
        received: Number(document.querySelector('#websocket-received').textContent),
      },
    }
  })
}

async function observe(page, label, duration = 3000) {
  await wait(1600)
  const start = await readStats(page)
  await wait(duration)
  const end = await readStats(page)
  assert.deepEqual(end.rtcLifecycle, start.rtcLifecycle, `${label} replaced the diagnostic peers`)
  const result = {
    label,
    duration,
    navigatorOnline: end.navigatorOnline,
    peers: end.peers,
    rtp: end.rtp.map((row, index) => {
      const deltas = Object.fromEntries(['packetsSent', 'packetsReceived', 'packetsLost', 'bytesSent', 'bytesReceived'].map((metric) => {
        const before = start.rtp[index][metric]
        const after = row[metric]
        return [metric, before === null || after === null ? null : after - before]
      }))
      return { deltas, lastSample: row }
    }),
    websocket: {
      status: end.websocket.status,
      sent: end.websocket.sent - start.websocket.sent,
      received: end.websocket.received - start.websocket.received,
    },
  }
  console.log(JSON.stringify(result))
  return result
}

async function fetchProbe(page) {
  return page.evaluate(async () => {
    try {
      const response = await fetch('/ping', { cache: 'no-store', signal: AbortSignal.timeout(2000) })
      return { status: response.status, body: await response.text() }
    } catch (error) {
      return { error: error.message }
    }
  })
}

async function runInPopup(cdp, targetId, expression) {
  // Playwright exposes browser tabs only. The action popup has its own CDP target.
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: false })
  let onResponse
  let timeout
  try {
    const result = new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Timed out waiting for the popup')), 7000)
      onResponse = (event) => {
        if (event.sessionId !== sessionId) return
        const response = JSON.parse(event.message)
        if (response.id !== 1) return
        const error = response.error?.message ?? response.result.exceptionDetails?.exception?.description
        if (error) reject(new Error(error))
        else resolve(response.result)
      }
      cdp.on('Target.receivedMessageFromTarget', onResponse)
    })
    await Promise.all([
      result,
      cdp.send('Target.sendMessageToTarget', {
        sessionId,
        message: JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true } }),
      }),
    ])
  } finally {
    clearTimeout(timeout)
    cdp.off('Target.receivedMessageFromTarget', onResponse)
    await cdp.send('Target.closeTarget', { targetId })
  }
}

async function usePopup({ tabId, action, mode, attached, packetLoss, checkControls }) {
  const get = (id) => document.getElementById(id)
  function layout() {
    const elements = document.querySelectorAll('body, label[for="loss"], #loss-value, #loss, #reordering, #queue-length, footer')
    return Array.from(elements, (element) => {
      const { x, y, width, height } = element.getBoundingClientRect()
      return [x, y, width, height].join(',')
    }).join('|')
  }
  let initialLayout
  async function until(condition, description) {
    const deadline = performance.now() + 2500
    while (!await condition()) {
      if (performance.now() > deadline) throw Error(`Popup did not reach ${description}; debugger=${get('connection')?.textContent}`)
      await new Promise((ready) => setTimeout(ready, 20))
    }
  }
  await until(() => get('mode-picker')?.disabled === false, 'ready')
  const prepare = get('prepare-webrtc')
  if (action === 'prepare') {
    if (!prepare?.getClientRects().length || prepare.disabled) throw Error('Prepare WebRTC is unavailable in unprepared Normal')
    prepare.click()
  } else if (action) {
    const radio = get(`mode-${action}`)
    if (radio.matches(':disabled')) throw Error(`${action} is disabled after Prepare`)
    radio.click()
    if (action === 'packet-loss') {
      const loss = get('loss')
      if (checkControls) {
        if (document.documentElement.scrollWidth > window.innerWidth) throw Error('Popup content overflows horizontally')
        get('reordering').click()
        const queue = get('queue-length')
        queue.value = '32'
        queue.dispatchEvent(new Event('input', { bubbles: true }))
        queue.dispatchEvent(new Event('change', { bubbles: true }))
        initialLayout = layout()
      }
      for (const value of checkControls ? [0, 9, 10, 99, 100, packetLoss] : [packetLoss]) {
        loss.value = String(value)
        loss.dispatchEvent(new Event('input', { bubbles: true }))
        if (get('loss-value').value !== `${value}%`) throw Error(`Loss readout did not update immediately to ${value}%`)
        if (checkControls) {
          if (/Applying|Current mode/i.test(document.body.innerText)) throw Error('Redundant mode status is visible')
          if (layout() !== initialLayout) throw Error(`Popup layout shifted at ${value}%`)
          if (value === 9 || value === 10) {
            await new Promise((ready) => setTimeout(ready, 80))
            if (layout() !== initialLayout) throw Error(`Popup layout shifted while holding ${value}%`)
          }
        }
      }
      loss.dispatchEvent(new Event('change', { bubbles: true }))
    }
  }
  const connection = attached ? 'CDP attached' : 'CDP detached'
  await until(async () => {
    if (!get('error').hidden) throw Error(get('error').textContent)
    const response = await chrome.runtime.sendMessage({ type: 'get-state', tabId })
    if (!response.ok) throw Error(response.error)
    const { state } = response
    return state.attached === attached && state.mode === mode
      && (mode !== 'packet-loss' || state.options.packetLoss === packetLoss)
      && (!checkControls || (state.options.packetReordering && state.options.packetQueueLength === 32))
      && get(`mode-${mode}`).checked && get('connection').textContent === connection
  }, `${mode}/${connection}`)
  if (checkControls && layout() !== initialLayout) throw Error('Popup layout shifted after committing the settings')
  if (Boolean(prepare.getClientRects().length) !== !attached) throw Error('Wrong Prepare button visibility')
  for (const name of ['packet-loss', 'offline']) {
    if (get(`mode-${name}`).matches(':disabled') !== !attached) throw Error(`Wrong ${name} availability`)
  }
  if (mode === 'packet-loss' && get('loss').value !== String(packetLoss)) {
    throw Error('Wrong packet loss slider value')
  }
}

async function main() {
  const [html, script, manifest] = await Promise.all([
    readFile(join(diagnostics, 'index.html')),
    readFile(join(diagnostics, 'diagnostics.js')),
    readFile(join(extensionDir, 'manifest.json'), 'utf8').then(JSON.parse),
  ])
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    switch (new URL(request.url, 'http://localhost').pathname) {
      case '/':
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.end(html)
        break
      case '/diagnostics.js':
        response.setHeader('Content-Type', 'application/javascript; charset=utf-8')
        response.end(script)
        break
      case '/ping':
        response.end('network-chaos-ping')
        break
      case '/child':
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.end('<!doctype html><title>Child frame</title>')
        break
      default:
        response.writeHead(404).end()
    }
  })
  const echo = new WebSocketServer({ server })
  let wsConnects = 0
  echo.on('connection', (socket) => {
    wsConnects += 1
    socket.on('message', (data, binary) => socket.send(data, { binary }))
  })
  const profile = await mkdtemp(join(tmpdir(), 'network-chaos-browser-'))
  let context
  try {
    await new Promise((ready, reject) => server.listen(0, '127.0.0.1', ready).once('error', reject))
    const { port } = server.address()
    const url = `http://127.0.0.1:${port}/`
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
    })
    await context.addInitScript(() => {
      window.rtcLifecycle = { created: 0, closed: 0, documentId: Math.random() }
      const NativePeer = window.RTCPeerConnection
      if (!NativePeer) return
      window.RTCPeerConnection = class extends NativePeer {
        constructor(...args) {
          super(...args)
          window.rtcLifecycle.created++
        }
        close() {
          window.rtcLifecycle.closed++
          super.close()
        }
      }
    })
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 10_000 })
    const { protocol, host } = new URL(worker.url())
    assert.equal(protocol, 'chrome-extension:')
    const popupUrl = `${protocol}//${host}/${manifest.action.default_popup}`
    const filePage = await context.newPage()
    await filePage.goto(pathToFileURL(join(diagnostics, 'index.html')).href)
    assert.ok((await readStats(filePage)).rtp.every((row) => row.packetsReceived === null && row.packetsLost === null))
    await filePage.locator('#start').click()
    await waitForRtp(filePage)
    assert.equal((await readStats(filePage)).rtcLifecycle.created, 2)
    await filePage.locator('#stop').click()
    assert.equal((await readStats(filePage)).rtcLifecycle.closed, 2)
    await filePage.close()

    const otherPage = await context.newPage()
    await otherPage.goto(`${url}?unconditioned`)
    await otherPage.locator('#start').click()
    await waitForRtp(otherPage)
    const page = await context.newPage()
    await page.goto(url)
    await page.bringToFront()
    const cdp = await context.newCDPSession(page)
    const tabId = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      return tab?.id
    })
    assert.ok(tabId, 'Could not resolve the focused tab')
    console.log(`Chrome ${await page.evaluate(() => navigator.userAgent)}; extension ${host}`)

    const popups = new Set()
    async function popupState({ action, mode = 'normal', attached, packetLoss, checkControls }) {
      await page.bringToFront()
      await worker.evaluate(() => chrome.action.openPopup())
      const { targetInfos } = await cdp.send('Target.getTargets')
      const popup = targetInfos.find((target) => target.url === popupUrl)
      assert.ok(popup, 'Chrome did not expose the action popup')
      assert.ok(!popups.has(popup.targetId), 'Expected a newly reopened action popup')
      popups.add(popup.targetId)
      await runInPopup(cdp, popup.targetId, `(${usePopup})(${JSON.stringify({ tabId, action, mode, attached, packetLoss, checkControls })})`)
      const badge = await worker.evaluate((tabId) => chrome.action.getBadgeText({ tabId }), tabId)
      assert.equal(badge, mode === 'packet-loss' ? `${packetLoss}%` : mode === 'offline' ? 'OFF' : '')
      const hasExtensionSession = await worker.evaluate((tabId) =>
        chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree').then(() => true, () => false), tabId)
      assert.equal(hasExtensionSession, attached, 'Unexpected extension CDP session')
    }
    const setMode = (mode, packetLoss) => popupState({ action: mode, mode, packetLoss, attached: true })
    const prepare = () => popupState({ action: 'prepare', attached: true })

    await popupState({ attached: false })
    await page.locator('#start').click()
    await waitForRtp(page)
    const cold = await readStats(page)
    await observe(page, 'cold: baseline')
    await prepare()
    await popupState({ attached: true })
    await setMode('packet-loss', 100)
    await observe(page, 'cold: Packet Loss 100% after RTP started')
    assert.deepEqual((await readStats(page)).rtcLifecycle, cold.rtcLifecycle)
    await setMode('normal')
    await page.locator('#stop').click()

    await popupState({ attached: true })
    await page.evaluate(() => {
      history.pushState(null, '', '?spa')
      location.hash = 'same-document'
    })
    await page.evaluate(async () => {
      const iframe = document.createElement('iframe')
      const load = (path) => new Promise((resolve) => {
        iframe.onload = resolve
        iframe.src = path
      })
      const first = load('/child?initial')
      document.body.append(iframe)
      await first
      await load('/child?navigated')
    })
    await popupState({ attached: true })
    await page.locator('#start').click()
    await waitForRtp(page)
    const prepared = await readStats(page)
    assert.deepEqual(prepared.rtcLifecycle, { documentId: cold.rtcLifecycle.documentId, created: 4, closed: 2 })
    await page.locator('#websocket-url').fill(`ws://127.0.0.1:${port}/echo`)
    await page.locator('#websocket-start').click()
    await page.waitForFunction(() => Number(document.querySelector('#websocket-received').textContent) > 0)
    assert.deepEqual(await fetchProbe(page), { status: 200, body: 'network-chaos-ping' })
    function assertRtp(measurement, receiving) {
      assert.ok(measurement.rtp.every(({ deltas }) => receiving
        ? deltas.packetsReceived > 0 && deltas.bytesReceived > 0
        : deltas.packetsSent > 0 && deltas.packetsReceived === 0 && deltas.bytesReceived === 0), measurement.label)
    }
    assertRtp(await observe(page, 'prepared: Normal before call'), true)
    for (const loss of [25, 75, 100]) {
      await setMode('packet-loss', loss)
      const measurement = await observe(page, `prepared: Packet Loss ${loss}%`)
      assert.equal(measurement.navigatorOnline, true)
      if (loss === 100) assertRtp(measurement, false)
    }
    await setMode('normal')
    assertRtp(await observe(page, 'same call: Normal keeps the session attached'), true)
    await setMode('packet-loss', 100)
    assertRtp(await observe(page, 'same call: Packet Loss 100% after Normal'), false)
    await setMode('packet-loss', 0)
    assertRtp(await observe(page, 'same call: RTP resumes at 0%'), true)

    const unrelatedBefore = await readStats(otherPage)
    await setMode('offline')
    const offlineHttp = await fetchProbe(page)
    const otherHttp = await fetchProbe(otherPage)
    console.log(JSON.stringify({ offlineHttp, otherHttp }))
    assert.ok(offlineHttp.error, 'Offline allowed a fresh HTTP request')
    assert.equal(otherHttp.status, 200)
    const offline = await observe(page, 'prepared: Offline', 8000)
    assert.equal(offline.navigatorOnline, false)
    assertRtp(offline, false)
    const unrelatedAfter = await readStats(otherPage)
    console.log(JSON.stringify({ unrelatedNavigator: unrelatedAfter.navigatorOnline, unrelatedRtpDelta: unrelatedAfter.rtp.map((row, index) => row.packetsReceived - unrelatedBefore.rtp[index].packetsReceived) }))
    assert.ok(unrelatedAfter.rtp.every((row, index) => row.packetsReceived > unrelatedBefore.rtp[index].packetsReceived))
    await setMode('normal')
    const normal = await observe(page, 'prepared: back to Normal', 5000)
    assert.equal(normal.navigatorOnline, true)
    assertRtp(normal, true)
    assert.deepEqual(await fetchProbe(page), { status: 200, body: 'network-chaos-ping' })
    assert.deepEqual((await readStats(page)).rtcLifecycle, prepared.rtcLifecycle)
    assert.equal(wsConnects, 1)

    await setMode('packet-loss', 75)
    assert.equal((await page.reload({ timeout: 10_000 })).status(), 200)
    assert.notEqual((await readStats(page)).rtcLifecycle.documentId, prepared.rtcLifecycle.documentId)
    await popupState({ attached: false })
    await prepare()

    await setMode('offline')
    assert.ok((await fetchProbe(page)).error, 'Expected the re-prepared tab to go Offline')
    await Promise.all([
      page.waitForEvent('request', {
        predicate: (request) => request.isNavigationRequest() && request.url() === new URL('/child?offline', url).href,
        timeout: 5000,
      }),
      page.evaluate(() => {
        const iframe = document.createElement('iframe')
        iframe.id = 'offline-child'
        iframe.addEventListener('load', () => { iframe.dataset.loaded = 'true' }, { once: true })
        iframe.src = '/child?offline'
        document.body.append(iframe)
      }),
    ])
    await page.locator('#offline-child[data-loaded="true"]').waitFor({ state: 'attached', timeout: 5000 })
    await popupState({ mode: 'offline', attached: true })
    assert.equal(await page.evaluate(() => navigator.onLine), false)
    assert.ok((await fetchProbe(page)).error, 'Child navigation lifted Offline for the parent')

    const offlineReload = await page.reload({ timeout: 10_000 })
    assert.equal(offlineReload.status(), 200)
    console.log(JSON.stringify({ offlineChildCompleted: true, offlineReload: offlineReload.status() }))
    await popupState({ attached: false })
    assert.equal(await page.evaluate(() => navigator.onLine), true)
    await prepare()
    await popupState({ attached: true })
    assert.deepEqual(await fetchProbe(page), { status: 200, body: 'network-chaos-ping' })
    await setMode('packet-loss', 25)
    await popupState({ action: 'packet-loss', mode: 'packet-loss', attached: true, packetLoss: 37, checkControls: true })
  } finally {
    await context?.close()
    for (const socket of echo.clients) socket.terminate()
    await new Promise((closed) => echo.close(closed))
    server.close()
    await rm(profile, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
