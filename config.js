// Shared by the service worker (background.js) and the popup.

export const DEFAULT_SERVER = 'http://127.0.0.1:6789';

// Every user setting with its default. Each one is its own key in chrome.storage.local, so
// `chrome.storage.local.get(DEFAULT_SETTINGS)` returns the stored values merged over the defaults.
export const DEFAULT_SETTINGS = Object.freeze({
    // Where records are POSTed. An empty string turns forwarding off.
    server: DEFAULT_SERVER,
    // CDP resource types that are not forwarded.
    // https://chromedevtools.github.io/devtools-protocol/tot/Network/#type-ResourceType
    ignoredTypes: ['Stylesheet', 'Script', 'Image', 'Media', 'Font', 'TextTrack', 'Manifest', 'Preflight'],
    // URL patterns, one per line. `*` matches anything; a pattern without `*` matches any URL
    // containing it. An empty include list lets every URL through; exclude wins over include.
    includeUrls: '',
    excludeUrls: '',
    // HTTP methods to forward, separated by commas or spaces. Empty means all.
    methods: '',
    // Request and response bodies longer than this many KB (as forwarded, so base64 for binary)
    // are replaced by a marker. 0 means no limit.
    maxBodyKB: 0,
    // Replace credentials (auth and cookie headers, cookie values) with "[REDACTED]".
    redact: false,
    // Reload the tab right after capture starts, so requests made during page load are included.
    reloadOnStart: false,
});

// Resource types the popup offers as checkboxes. The others keep their default.
export const TOGGLEABLE_TYPES = ['Document', 'XHR', 'Fetch', 'Script', 'Stylesheet', 'Image', 'Font', 'Media', 'Other'];

// chrome.storage.session key for the capture state shared with the popup:
// { tabId, stats: { forwarded, failed, skipped }, lastSendError }
export const CAPTURE_STATE_KEY = 'capture';
