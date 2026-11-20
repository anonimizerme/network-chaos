# Network Chaos diagnostics

**Before the caller places the call, click Prepare tab in the test tab and wait for Prepared.** This applies to the callee's tab too. The initial mode is Normal. Once prepared, you can switch between Normal, Packet Loss and Offline during the call. If the socket already existed when you clicked Prepare, start a fresh connection and compare the change in `inbound-rtp.packetsReceived` at the receiver. Chromium registers each WebRTC UDP socket with the network emulator when it creates the socket. [Chromium UDP socket implementation](https://github.com/chromium/chromium/blob/main/services/network/p2p/socket_udp.cc) · [Chromium throttling rules](https://github.com/chromium/chromium/blob/main/services/network/throttling/throttling_controller.cc)

## Modes

| Mode | Behavior |
| --- | --- |
| Normal | Before Prepare, the debugger is detached. After Prepare, the debugger stays attached with 0% loss, no reordering and no queue limit. Chrome reports its usual value for `navigator.onLine`. |
| Packet Loss | Applies a Chrome DevTools Protocol (CDP) rule across the target tab. Set WebRTC packet loss from 0 to 100%, with optional packet reordering and a queue length limit. Added latency is 0 and throughput is unlimited. At 0% the rule stays in place, so you can adjust loss later on the same connection. |
| Offline | Applies an offline rule, requests 100% WebRTC packet loss and separately sets `navigator.onLine` to `false` through CDP. The effect on existing connections depends on Chrome's implementation. |

The popup controls the active tab in the current window. Changes take effect immediately and stay active on that tab when you close the popup or switch tabs. Choose Normal to suspend emulation between measurements. Reloading the page or navigating to a new document ends the prepared session. A same-document route change preserves it. If the application ends the call or closes a WebSocket after a timeout, it must establish a new connection to resume.

The percentage in the popup is the loss rate configured in CDP. On the diagnostics page, both peers share a tab. Chromium applies loss on both send and receive, so the fraction of packets lost between these peers can exceed the slider value. In a call with a remote participant, measure each direction at its receiver. [Chromium P2P send and receive handling](https://github.com/chromium/chromium/blob/main/services/network/throttling/throttling_p2p_network_interceptor.cc)

## Chrome test results

A Chrome for Testing 147 run exercised the Prepare button through the real extension popup. On the same two-way WebRTC call, the receivers gained 0 / 0 packets at 100% loss, 280 / 155 after returning to Normal, and 0 / 0 after switching back to 100%. Each measurement lasted three seconds. The original peer connections stayed open. Closing and reopening the popup, changing a hash or history entry, and navigating a child frame all preserved preparation.

In a separate Chrome 156.0.8078.82 run, all 10 reloads from Offline returned HTTP 200 on the first attempt. Each loaded a fresh server response, restored `navigator.onLine` and left the popup in Normal with Prepare available. Nine reloads used `Page.reload` and one used `chrome.tabs.reload`.

In Chrome for Testing 147, a same-origin iframe loaded a fresh document with HTTP 200 while the parent tab was Offline. A fresh `fetch` from the parent still failed and the popup stayed in Offline. A direct CDP test without `Fetch.enable` produced the same result.

With an earlier build that detached on entering Normal, Chrome 156.0.8078.82 let an existing connection bypass later rules. After detaching and setting 100% again, each receiver still gained 153 packets in three seconds. Starting a fresh connection after confirming 0% made 100% loss effective again on the same page. This is why a prepared tab now keeps its CDP session in Normal.

On November 20, 2026, on macOS, the test opened the unpacked extension's popup in Chrome for Testing 147.0.7727.15 and switched modes in a tab carrying two-way audio over UDP. The table shows the increase in `inbound-rtp.packetsReceived` at each receiver in one run. The sender continued to generate RTP at 100% loss and in Offline mode.

| When the rule was applied | Mode | Packets received A → B / B → A | Interval |
| --- | --- | ---: | ---: |
| Call started before preparation | Normal | 154 / 154 | 3 s |
| Emulation first enabled during that call | 100% | 154 / 154 | 3 s |
| 0% applied before a new call | 0% | 154 / 154 | 3 s |
| Same call, loss adjusted during the call | 25% | 100 / 85 | 3 s |
| | 75% | 12 / 11 | 3 s |
| | 100% | 0 / 0 | 3 s |
| | Back to 0% | 256 / 257 | 3 s |
| | Offline | 0 / 0 | 8 s |
| | Normal | 254 / 254 | 5 s |

In Offline mode, a fresh HTTP request failed with `Failed to fetch`, `navigator.onLine` became `false` and ICE entered `disconnected`. The WebSocket opened at 0% stayed open. In 8 seconds offline, the page called `send()` 8 times and received 0 echo replies. After switching back to Normal, fresh HTTP requests returned 200, the page received 5 echo replies in 5 seconds and ICE returned to `connected`. The page retained the same document and connection objects. A second tab with the same origin continued to receive RTP and HTTP 200 responses.

A separate check loaded the earlier build into a temporary profile in the installed Google Chrome 156.0.8078.82. Clicking the extension's toolbar action opened the popup with the tab title. In Offline mode, the popup showed Attached, the badge read OFF, `navigator.onLine` became `false` and a fresh HTTP request failed. After switching to Normal, a new request to the same server succeeded.

A separate RTP check in Chrome 156 sent CDP commands directly to the diagnostics page. When 100% loss was first enabled during a call, each direction still received 200 packets in 4 s. With 0% set before the call, switching to 100% yielded 0 packets received in 4 s in each direction. Returning to 0% yielded 201 packets per direction. In Offline mode, each of those peers reported 351 packets sent and 0 received in 6.5 s. Back in Normal, each direction received 200 packets in 4 s. The `packetsLost` counters could stay flat throughout a complete loss of traffic.

In a MAX call between two Chrome 156 profiles, the extension ran in the callee's tab. During the first call at 71% loss, video kept reaching the other participant. The receiver counted 4848 more packets in 30 s while `packetsLost` stayed flat. The test did not establish when the rule attached to that call's socket. Before the caller placed a second call, the callee confirmed Packet Loss at 0% and Attached. Incoming audio on the new call received 503 packets in 10 s at 0%, with no increase in the loss counter. At 71%, the counters recorded 110 more packets received and 139 more lost in 5 s. At 100%, the receive counters held at 2110 packets and 149887 bytes for 7 s. Returning to 0% restored reception on the same connection.

Mock tests cover switching and reapplying modes, serializing operations, tab isolation and closure, attach and detach errors, CDP command failures, unexpected debugger disconnection and service worker restarts. Physical Wi-Fi loss, remote calls over TURN, DataChannel behavior and observed packet reordering still need verification in the target environment.

## Testing live connections

### WebRTC

1. Open the diagnostics page in a regular Chrome tab. It creates its own WebRTC connections. For a call in another application, use the receiver's statistics or open `chrome://webrtc-internals` in a separate tab before the call starts. [Diagnostics page](./index.html)
2. **Prepare during a call.** Start a test connection before clicking Prepare and wait until the receiver's counters increase steadily. Click Prepare, switch to Packet Loss at 100% and compare several consecutive samples. If the counter keeps rising at the same rate, record that the rule missed the existing socket.
3. **Prepare before a call.** Start a fresh connection in prepared Normal. Wait for RTP, then step through 25% → 75% → 100% → Normal → 100% on the same connection. Record the changes in `packetsReceived`, `bytesReceived` and `packetsLost`. After allowing buffers to drain, confirm that reception stops at both 100% intervals and resumes in Normal. Reopen the popup between steps to verify that the other modes stay available.
4. Switch a live connection to Offline. Record `connectionState` and `iceConnectionState`, including the time of any change. Return to Normal and repeat the measurement. A short interruption may end before ICE changes state. The `packetsLost` counter may also stop updating until the next RTP packet arrives. Use the receiver's counters to confirm delivery.
5. Keep a call running in Normal in a second tab. Compare its reception before and after changing the first tab's mode. To check debugger disconnection handling, open DevTools in the **tab under test** and inspect its popup and badge. Close DevTools before applying the next mode.

### HTTP and WebSocket

1. In the application under test, pick an action that makes a fresh server request each time. Check for success in Normal, failure in Offline and a fresh success after returning to Normal. You can use `fetch` with `cache: 'no-store'` against a URL on your test server. A page with a service worker may still display cached data while offline.
2. In the diagnostics page's **WebSocket echo** section, enter the URL of your echo server and connect. Wait for replies and leave the socket open. The page sends a numbered message once per second. Watch both counters before, during and after Offline. Use echo replies to verify delivery, since a socket can report `OPEN` and accept a `send()` call while no replies arrive.
3. After returning to Normal, check whether queued messages come back and whether a **new** message gets a reply on the same socket. Record if the socket closed on its own or the application reconnected.
4. To compare emulation with a physical Wi-Fi disconnect, repeat the test against an external host with the extension in Normal. Use a separate device or a network with no fallback route. A loopback connection on one computer can keep working when Wi-Fi is off. Record the selected ICE candidate pair, time to failure, WebSocket messages and recovery after network access returns.

## CDP behavior and scope

- `Network.emulateNetworkConditionsByRule` takes a `matchedNetworkConditions` array. An empty `urlPattern` includes P2P traffic. The protocol defines `packetLoss`, `packetReordering` and `packetQueueLength`. Queue length is measured in packets, with 0 lifting the limit. Reordering depends on queue conditions. [CDP Network schema](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Network.pdl)
- `Network.overrideNetworkState` controls the state reported by Navigator. Check HTTP access and RTP delivery separately. In Blink, documents sharing a renderer process may receive the same network state notification. The extension sends conditions to the selected tab's CDP target. Out-of-process frames and independent workers may have separate targets. [Blink implementation](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/inspector/inspector_network_agent.cc) · [Targets in chrome.debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger#concepts-and-usage)
- In Offline mode, CDP pauses document requests. A main-frame request ends preparation and detaches the debugger so Chrome can load the destination on the first attempt. Child-frame requests continue under the current network rule. [CDP Fetch domain](https://chromedevtools.github.io/devtools-protocol/tot/Fetch/)
- Emulation runs inside the browser. The operating system's routes, Wi-Fi and the external host remain available. TURN/TCP, different ICE configurations, WebSockets and HTTP may respond differently to Offline. Chrome restricts debugging of internal pages and may detach the extension's debugger when DevTools opens. [Chrome Debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)

The manifest allows Chrome 118 and later. Emulation requires experimental Network commands. In Chrome builds that lack them, the popup shows the command error. The extension uses only the newer commands and has no fallback to the deprecated `Network.emulateNetworkConditions`. When the service worker restarts, it checks its existing debugger session and the prepared document before restoring a mode. If Chrome has ended the session, the user must prepare the page again.

The extension requests `debugger` to send CDP commands and `storage` to keep session state.
