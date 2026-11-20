# Network Chaos privacy policy

Network Chaos simulates network conditions in a Chrome tab you choose. Clicking **Prepare tab** connects the extension to that tab through Chrome’s debugger. The extension uses Chrome’s navigation events to detect when the test page changes and reset the network settings.

During a test, Network Chaos keeps the selected mode, packet loss percentage, packet reordering setting, queue length, and temporary tab and document identifiers in Chrome’s session storage. This lets the test continue when the popup closes or Chrome restarts the extension’s background worker. Closing the tab clears its test settings. Restarting Chrome clears session storage.

The extension does not record call audio or video, page content, browsing history, or the contents of network requests. It has no analytics and sends no test data to the developer or third parties.

Network Chaos uses information from Chrome APIs only to run the network test you request. This use complies with the Chrome Web Store User Data Policy, including its [Limited Use requirements](https://developer.chrome.com/docs/webstore/program-policies/limited-use).
