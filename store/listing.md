# Chrome Web Store listing

Copy-paste material for the Request Pipeline item in the [developer dashboard](https://chrome.google.com/webstore/devconsole). The text describes **1.2.0**; update it when 1.3.0 ships (iframes, workers, WebSocket and SSE capture).

Images are in `store/images/` and are regenerated with `EXTENSION_DIR=<unpacked release> npm run store-assets`.

## Summary (from `manifest.json`, max 132 characters)

The dashboard shows the package's `description` field here and doesn't let you edit it. 1.2.0 still has the old one; from 1.3.0 it is:

```
Stream a tab's network requests and responses to your own server as JSON, for scripts, tests and API debugging.
```

## Description

```
Request Pipeline streams the network traffic of a browser tab to a server you run, in real time, as JSON. Feed the API calls of a real, logged-in session into your own scripts, tests, mocks or data tools, without a proxy and without keeping DevTools open.

HOW IT WORKS
1. Run a receiver. A ready-made one ships with the source code: python3 examples/receiver.py (Python 3, no dependencies). It prints each request and can save JSONL or a HAR file that opens in Chrome DevTools. Any HTTP endpoint that accepts JSON POSTs works too.
2. Open the page you care about, click the extension icon and press Start capture.
3. Each finished request is POSTed to your server as one JSON record: the request (method, URL, headers, full body), the response (status, headers), cookies, the response body, timing and metadata.

While capturing, Chrome shows a "Request Pipeline started debugging this browser" banner. That is how Chrome's debugger API works. Press Stop capture, or Cancel on the banner, to end it.

FEATURES
• Start and stop from the popup, with live counts of forwarded, failed and skipped requests, and a counter on the toolbar icon.
• Reload the page when capture starts, to catch the requests a page makes while loading.
• Choose resource types (documents, XHR, fetch, scripts, images and more), include or skip URL patterns, and filter by HTTP method.
• Body size limit: larger bodies are replaced by a marker that keeps their length.
• Redact credentials: Authorization, Cookie, Set-Cookie and other credential headers, and all cookie values, become [REDACTED] before anything is sent.
• Settings apply immediately, even during a capture.
• Clear errors when your server is down or a tab can't be captured, and a warning when the server address isn't on your computer or isn't encrypted.

PRIVACY
Captured data goes only to the server address you set. By default that is http://127.0.0.1:6789, your own computer. Nothing is sent to the developer or to any third party. Records can include cookies and auth headers, so only forward to servers you trust, or turn on Redact credentials.

PERMISSIONS
• Debugger: reads the network traffic of the tab you choose, only while you are capturing it.
• Tabs: lists your open tabs in the popup so you can pick one.
• Storage: remembers your settings.
• Access to websites: sends records to the server address you configure.

Source code, record format and the receiver: https://github.com/GanymedeNil/request-pipeline
Bugs and ideas: https://github.com/GanymedeNil/request-pipeline/issues
```

## Privacy practices tab

**Privacy policy URL**: replace the termsfeed link with the project's own policy, which describes exactly what the code does:

```
https://www.ganymedenil.com/request-pipeline/privacy.html
```

**Single purpose**

```
Forward the network requests and responses of a browser tab the user chooses to a server address the user configures, so developers can process them with their own tools.
```

**Permission justifications** (`storage` is new in 1.2.0; the dashboard asks for it before you can submit)

| Permission | Justification |
| --- | --- |
| `debugger` | `Attaches to the tab the user chooses, only after they press Start capture, to read its network requests and responses through the Network domain of the Chrome DevTools Protocol. This is the extension's core function.` |
| `tabs` | `Lists the user's open tabs (titles and URLs) in the popup so they can choose which tab to capture.` |
| `storage` | `Saves the user's settings (server address, filters, options) and the state of a running capture, so it survives the service worker restarting.` |
| Host permissions (`http://*/*`, `https://*/*`) | `Sends captured records to the server address the user enters, which can be any http(s) URL. The default is http://127.0.0.1:6789 on the user's own computer.` |
| Remote code | `No, I am not using remote code.` |

**Data usage**: the current disclosure lists *User activity* and *Website content*. Records can also contain cookies and `Authorization` headers, which the dashboard classes as *Authentication information*; consider ticking it too. Data is sent only to the endpoint the user configures, never to the developer.

## Store listing tab: links

| Field | Value |
| --- | --- |
| Homepage URL | `https://www.ganymedenil.com/request-pipeline/` |
| Support URL | `https://github.com/GanymedeNil/request-pipeline/issues` |

## Images

| Dashboard field | File | Size |
| --- | --- | --- |
| Screenshot 1 | `store/images/screenshot-1-capture.png` | 1280×800 |
| Screenshot 2 | `store/images/screenshot-2-options.png` | 1280×800 |
| Screenshot 3 | `store/images/screenshot-3-json.png` | 1280×800 |
| Small promo tile | `store/images/promo-small-440x280.png` | 440×280 |
| Marquee promo tile | `store/images/promo-marquee-1400x560.png` | 1400×560 |

Remove the old screenshot slot, which currently shows a blank placeholder.

## Release steps

1. **Package** tab → *Upload new package* → `request-pipeline-1.2.0.zip` from the [v1.2.0 release](https://github.com/GanymedeNil/request-pipeline/releases/tag/v1.2.0). If the dashboard asks for a signed `.crx` instead, Verified CRX Uploads is on and the lost key matters: contact Chrome Web Store developer support to replace it (Google says this can take up to a week).
2. **Store listing** tab → replace the description, delete the old screenshot, upload the three screenshots and both promo tiles. Category stays *Developer Tools*.
3. **Privacy practices** tab → add the `storage` justification; review the others and the data usage boxes.
4. *Save draft*, check the preview, then *Submit for review*.
