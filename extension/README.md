# Shadowbill Collector extension

1. Run `npm run serve` from the repository root.
2. Read the generated token from `~/.shadowbill/collector-token`.
3. Open `chrome://extensions`.
4. Enable Developer mode.
5. Choose **Load unpacked** and select this `extension` directory.
6. Open the popup, paste the collector token, and choose **Save and test**.

The extension sends aggregate token estimates and hashed turn identifiers to `127.0.0.1`. It sends each event with bearer authentication. Message text stays in the page and never enters the collector request.

Turn completion uses three signals: a following message, completed-response controls, or a quiet period after generation ends. If visible context or output changes later, the extension emits a content-addressed revision. Shadowbill's reports retain the latest capture for that logical turn and expose how many earlier captures were superseded.

The token is stored in `chrome.storage.local` for this extension profile. Keep the unpacked extension directory and browser profile under your control.

ChatGPT's DOM can change, so completion and identity rules live in a small adapter with DOM-free tests.
