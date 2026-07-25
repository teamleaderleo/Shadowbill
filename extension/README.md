# Proofwake Shadowbill Collector extension

This optional extension feeds aggregate AI-usage estimates into Proofwake's Shadowbill module.

1. Run `npm run serve` from the repository root.
2. Open the collector-token file path printed by `proofwake serve` and copy its value.
3. Open `chrome://extensions`.
4. Enable Developer mode.
5. Choose **Load unpacked** and select this `extension` directory.
6. Open the popup, paste the collector token, and choose **Save and test**.

New installations use `~/.proofwake` by default. Existing `~/.shadowbill` installations remain supported until an explicit migration is performed. Run `proofwake status` to see which data and token paths are active.

The extension sends aggregate token estimates and hashed turn identifiers to `127.0.0.1`. It sends each event with bearer authentication. Message text stays in the page and never enters the collector request.

Turn completion uses three signals: a following message, completed-response controls, or a quiet period after generation ends. If visible context or output changes later, the extension emits a content-addressed revision. Proofwake's Shadowbill reports retain the latest capture for that logical turn and expose how many earlier captures were superseded.

The token is stored in `chrome.storage.local` for this extension profile. Legacy storage keys remain in place during the naming migration so existing extension configuration is preserved. Keep the unpacked extension directory and browser profile under your control.

ChatGPT's DOM can change, so completion and identity rules live in a small adapter with DOM-free tests. This collector remains optional; Proofwake's repository and revision evidence features must work without it.
