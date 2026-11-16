// Shared setup for the browser tests: a target site, receivers, and Chrome with the extension loaded.
//
// Environment:
//   EXTENSION_DIR   extension to load (default: the repository root). CI points it at the unpacked zip.
//   CHROME_PATH     Chrome or Chromium binary to use (default: Playwright's Chromium).
//   SCREENSHOT_DIR  if set, popup screenshots are saved there.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..');
export const EXTENSION_DIR = path.resolve(process.env.EXTENSION_DIR ?? REPO_ROOT);
export const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR ? path.resolve(process.env.SCREENSHOT_DIR) : null;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `fn` until it returns something truthy, or returns null after `ms`. */
export async function waitFor(fn, ms = 6000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const value = await fn();
        if (value) {
            return value;
        }
        await sleep(100);
    }
    return null;
}

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
);

/**
 * The pages being captured.
 * - `/` makes a GET with an auth header and a 300 KB POST on load.
 * - `/full` embeds a cross-site iframe (served from `localhost`, so it runs in its own process), starts
 *   a dedicated worker, reads two EventSource messages and talks to a WebSocket echo server.
 */
export async function startSite() {
    let port = 0;
    /** @type {http.RequestListener} */
    const handle = (req, res) => {
        const url = new URL(req.url, 'http://x');
        const html = (body) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);
        if (url.pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'sid=abc123; Path=/' });
            res.end(`<!doctype html><title>Target shop</title>
<script src="/app.js?v=3"></script><img src="/logo.png">
<script>
window.addEventListener('load', async () => {
  await fetch('/api/data?x=1', { headers: { Authorization: 'Bearer top-secret' } });
  await fetch('/api/upload', { method: 'POST', body: 'x'.repeat(300000) });
  document.title = 'done';
});
</script>`);
        } else if (url.pathname === '/full') {
            html(`<!doctype html><title>Full capture</title>
<iframe src="http://localhost:${port}/frame"></iframe>
<script>
new Worker('/worker.js');
let sse = 0;
const es = new EventSource('/sse');
es.addEventListener('tick', () => ++sse === 2 && es.close());
es.onmessage = () => ++sse === 2 && es.close();
let echoes = 0;
const ws = new WebSocket('ws://127.0.0.1:${port}/ws');
ws.binaryType = 'arraybuffer';
ws.onopen = () => { ws.send('hello'); ws.send(new Uint8Array([1, 2, 3])); };
ws.onmessage = () => ++echoes === 2 && ws.close();
</script>`);
        } else if (url.pathname === '/frame') {
            html(`<!doctype html><script>fetch('/api/in-iframe')</script>`);
        } else if (url.pathname === '/worker.js') {
            res.writeHead(200, { 'Content-Type': 'application/javascript' }).end(`fetch('/api/from-worker')`);
        } else if (url.pathname === '/sse') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
            res.write('event: tick\ndata: 1\n\n');
            res.write('data: two\n\n');
        } else if (url.pathname === '/app.js') {
            res.writeHead(200, { 'Content-Type': 'application/javascript' }).end('window.appLoaded = true;');
        } else if (url.pathname === '/logo.png') {
            res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }).end(PNG);
        } else if (url.pathname === '/api/big') {
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: 'z'.repeat(5000) }));
        } else if (url.pathname.startsWith('/api/') || url.pathname === '/other') {
            let size = 0;
            req.on('data', (chunk) => (size += chunk.length));
            req.on('end', () => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ path: url.pathname, query: url.search, received: size }));
            });
        } else {
            res.writeHead(404).end();
        }
    };

    const server = http.createServer(handle).on('upgrade', acceptEchoWebSocket);
    port = await listen(server);
    // `localhost` may resolve to ::1; serve it there too when IPv6 is available.
    const server6 = http.createServer(handle).on('upgrade', acceptEchoWebSocket);
    await new Promise((resolve) => server6.once('error', resolve).listen(port, '::1', resolve));
    return {
        url: `http://127.0.0.1:${port}/`,
        close: () => {
            for (const s of [server, server6]) {
                s.close();
                s.closeAllConnections();
            }
        },
    };
}

/**
 * A minimal WebSocket server: echoes text as "echo:<text>" and binary as is, and answers close.
 * Enough for the tests (small, unfragmented frames); not a general implementation.
 * @param {http.IncomingMessage} req
 * @param {import('node:stream').Duplex} socket
 */
function acceptEchoWebSocket(req, socket) {
    const accept = crypto
        .createHash('sha1')
        .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
    socket.on('error', () => {});
    socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const frame = (opcode, payload) => Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 6) {
            const opcode = buffer[0] & 0x0f;
            const length = buffer[1] & 0x7f; // client frames here are < 126 bytes and always masked
            if (buffer.length < 6 + length) {
                return;
            }
            const mask = buffer.subarray(2, 6);
            const payload = Buffer.from(buffer.subarray(6, 6 + length).map((byte, i) => byte ^ mask[i % 4]));
            buffer = buffer.subarray(6 + length);
            if (opcode === 0x8) {
                socket.end(frame(0x8, Buffer.alloc(0)));
                return;
            }
            socket.write(opcode === 0x1 ? frame(0x1, Buffer.from(`echo:${payload}`)) : frame(opcode, payload));
        }
    });
}

/** examples/receiver.py writing JSONL and HAR into a temporary directory. */
export async function startPythonReceiver() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-e2e-receiver-'));
    const jsonlPath = path.join(dir, 'out.jsonl');
    const harPath = path.join(dir, 'out.har');
    const child = spawn('python3', [
        path.join(REPO_ROOT, 'examples/receiver.py'),
        '--port',
        '0',
        '--jsonl',
        jsonlPath,
        '--har',
        harPath,
    ]);
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    const port = await new Promise((resolve, reject) => {
        let stderr = '';
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
            const match = stderr.match(/Listening on http:\/\/127\.0\.0\.1:(\d+)/);
            if (match) {
                resolve(Number(match[1]));
            }
        });
        child.on('exit', (code) => reject(new Error(`receiver exited with ${code}: ${stderr}`)));
    });
    return {
        url: `http://127.0.0.1:${port}/`,
        records: () =>
            fs.existsSync(jsonlPath)
                ? fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
                : [],
        har: () => JSON.parse(fs.readFileSync(harPath, 'utf8')),
        stdout: () => stdout,
        close: () => {
            child.kill();
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

/** A plain Node receiver that keeps records in memory. */
export async function startNodeReceiver() {
    const records = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
            records.push(JSON.parse(body));
            res.writeHead(200).end('ok');
        });
    });
    const port = await listen(server);
    return {
        url: `http://127.0.0.1:${port}/collect`,
        records,
        close: () =>
            new Promise((resolve) => {
                server.close(resolve);
                server.closeAllConnections();
            }),
    };
}

/** Launches Chrome with the extension and returns helpers for driving it. */
export async function launchBrowser() {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-e2e-profile-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
        ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' }),
        headless: true,
        args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15000 }));
    const extensionId = new URL(worker.url()).host;

    const workerErrors = [];
    const watch = (w) => w.on('console', (msg) => msg.type() === 'error' && workerErrors.push(msg.text()));
    watch(worker);
    context.on('serviceworker', watch);

    return {
        context,
        extensionId,
        workerErrors,
        close: async () => {
            await context.close();
            fs.rmSync(userDataDir, { recursive: true, force: true });
        },
    };
}

/** Opens the popup as a tab (headless Chrome has no toolbar) with helpers for it. */
export async function openPopup(browser) {
    const page = await browser.context.newPage();
    await page.setViewportSize({ width: 360, height: 700 });
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    const url = `chrome-extension://${browser.extensionId}/popup.html`;

    const popup = {
        page,
        errors,
        async reload() {
            await page.goto(url);
            await page.waitForFunction(() => document.getElementById('tab').options.length > 0);
            await sleep(100);
        },
        status: () => page.evaluate(() => chrome.runtime.sendMessage({ type: 'status' })),
        badge: () =>
            page.evaluate(async () => ({
                text: await chrome.action.getBadgeText({}),
                color: await chrome.action.getBadgeBackgroundColor({}),
            })),
        text: (selector) => page.$eval(selector, (el) => (el.hidden ? '' : el.textContent)),
        /** Types into a settings field and commits it. */
        async setField(selector, value) {
            await page.fill(selector, String(value));
            await page.dispatchEvent(selector, 'change');
            await sleep(150);
        },
        async ensureOptionsOpen() {
            if (!(await page.$eval('#options', (el) => el.open))) {
                await page.click('#options summary');
            }
            // The open state is saved from the asynchronous `toggle` event; newer Chrome fires it
            // after click() returns, so wait for it before anything reloads the popup.
            await page.waitForFunction(() => localStorage.getItem('optionsOpen') === '1');
        },
        async screenshot(name) {
            if (!SCREENSHOT_DIR) {
                return;
            }
            fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
            for (const scheme of ['light', 'dark']) {
                await page.emulateMedia({ colorScheme: scheme });
                await page.locator('body').screenshot({ path: path.join(SCREENSHOT_DIR, `${name}-${scheme}.png`) });
            }
            await page.emulateMedia({ colorScheme: 'light' });
        },
    };
    await popup.reload();
    return popup;
}

/** Stops the extension's service worker the way Chrome does when it's idle, via CDP. */
export async function stopServiceWorker(browser, page) {
    const cdp = await browser.context.newCDPSession(page);
    const versions = new Map();
    const transitions = [];
    cdp.on('ServiceWorker.workerVersionUpdated', ({ versions: updated }) => {
        for (const v of updated.filter((v) => v.scriptURL.includes(browser.extensionId))) {
            versions.set(v.versionId, v.runningStatus);
            transitions.push(v.runningStatus);
        }
    });
    await cdp.send('ServiceWorker.enable');
    await waitFor(() => [...versions.values()].includes('running'));
    for (const versionId of versions.keys()) {
        await cdp.send('ServiceWorker.stopWorker', { versionId });
    }
    const stopped = await waitFor(() => [...versions.values()].every((s) => s === 'stopped'), 5000);
    return { stopped: Boolean(stopped), transitions };
}
