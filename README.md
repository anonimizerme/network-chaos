# Network Chaos

A Chrome extension for simulating WebRTC packet loss and offline conditions in a single tab.

## Installation

**Download the extension.** Open the [latest release](https://github.com/anonimizerme/network-chaos/releases/latest). Under **Assets**, download `network-chaos-<version>-chrome.zip` and extract it.

**Or build from source.** With Node.js 22.13 or later in the 22.x series, or Node.js 24 or later, run these commands from the project root. The build creates the `dist/` folder.

```sh
npm ci
npm run build
```

**Load the extension in Chrome.** Open `chrome://extensions`, enable **Developer mode**, and click **Load unpacked**. Select the extracted folder containing `manifest.json` or, for a local build, select `dist/`.

After rebuilding an installed copy, click **Reload** on the Network Chaos card at `chrome://extensions`. If the popup detects an older background worker, you can click **Reload extension** in the popup instead. Reopen Network Chaos on the test tab and click **Prepare** again. Reloading the extension ends its active emulation sessions.

## Usage

![Network Chaos walkthrough: prepare the tab before dialing, increase packet loss to freeze the remote video, then select Normal to restore it.](docs/network-chaos.gif)

Open Network Chaos in the tab you want to test. A new page starts in **Normal** with **Packet Loss** and **Offline** disabled. Before either participant places a WebRTC call, click **Prepare** and wait for **Attached**. Normal stays selected, the other modes become available, and Prepare disappears.

- **Packet Loss** sets WebRTC packet loss from 0% to 100%. You can also enable packet reordering and set the queue length.
- **Offline** blocks network-dependent requests from the controlled page and sets `navigator.onLine` to `false`. Child frames and existing WebSocket or WebRTC connections may behave differently.
- **Normal** restores unrestricted traffic. After Prepare, Normal keeps the zero-loss rule active so you can turn losses on again during the same call.

Closing and reopening the popup preserves preparation. Reloading the tab or opening a new document returns it to Normal with Prepare available again. If Chrome disconnects the debugger, the popup shows the reason and offers Prepare again. A WebRTC socket created before preparation may continue passing traffic even at 100% loss.

**WebTransport.** The Packet Loss slider applies only to WebRTC. In local HTTP/3 echo tests on Chrome 147 and 156, both existing and newly opened WebTransport sessions exchanged datagrams and bidirectional stream data at 100% loss. They also continued to work in Offline, even while a fresh HTTP request from the same page failed. The Chrome 147 test used the extension, and the Chrome 156 test used its CDP commands directly.

Chromium 159 changed Offline handling for WebTransport. Click **Prepare** before opening the session. Switching to **Offline** then closes that session and blocks new connections while Offline is active. This behavior is covered by [Chromium's implementation and tests](https://github.com/chromium/chromium/commit/3feba4b13d1d81becddcb8912d1288d2db0eae64).

## Development

Run `npm run dev` to reload the extension as you edit. Use `npm test` for unit tests, `npm run typecheck` for type checks, and `npm run zip` to create a ZIP in `.output/`.

To run the browser test, build the extension, run `npx playwright install chromium`, then run `npm run test:browser`. For manual testing, see the [diagnostics page](./diagnostics/index.html) and [test scenarios and results](./diagnostics/README.md).

To publish from GitHub, open [Actions → Release Chrome extension](https://github.com/anonimizerme/network-chaos/actions/workflows/release.yml), click **Run workflow**, select the branch, and confirm. After the checks and build pass, the workflow tags the selected commit with the version from `package.json` (for example, `v1.0.0`) and publishes the ZIP in GitHub Releases. Bump the package version before publishing the next release.

You can also trigger the same release by pushing a matching tag.
