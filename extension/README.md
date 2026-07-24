# Shadowbill Collector extension

1. Run `npm run serve` from the repository root.
2. Read the generated token from `~/.shadowbill/collector-token`.
3. Open `chrome://extensions`.
4. Enable Developer mode.
5. Choose **Load unpacked** and select this `extension` directory.
6. Open the popup, paste the collector token, and choose **Save and test**.

The extension sends aggregate token estimates and a hash of the conversation URL to `127.0.0.1`. It sends each event with bearer authentication. Message text stays in the page and never enters the collector request.

The token is stored in `chrome.storage.local` for this extension profile. Keep the unpacked extension directory and browser profile under your control.

ChatGPT's DOM can change, so the selector lives in one small content script and should be treated as an adapter.
