// Shared by the service worker (background.js) and the popup.

export const DEFAULT_SERVER = 'http://127.0.0.1:6789';

// chrome.storage.local key holding the server address. An empty string means "don't forward".
export const SERVER_STORAGE_KEY = 'server';
