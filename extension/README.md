# Shadowbill Collector extension

1. Run `npm run serve` from the repository root.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Choose **Load unpacked** and select this `extension` directory.
5. Open the popup and test the local collector.

The extension sends aggregate token estimates and a hash of the conversation URL to `127.0.0.1`. It does not send message text to the collector. ChatGPT's DOM can change, so the selector lives in one small content script and should be treated as an adapter.
