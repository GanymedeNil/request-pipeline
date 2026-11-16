// Renders the Chrome Web Store screenshots and promo tiles into store/images/.
//
// The popup images, receiver output and JSON record are real: a demo shop at shop.example (a
// reserved documentation domain, mapped to 127.0.0.1) is captured by the extension and forwarded to
// examples/receiver.py on the default port. The layouts around them are HTML rendered at the exact
// sizes the Store asks for.
//
// Usage: EXTENSION_DIR=<unpacked release> npm run store-assets
//   EXTENSION_DIR  the version being published (default: the repository root)
//   CHROME_PATH    optional Chrome for Testing / Chromium binary

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXTENSION_DIR = path.resolve(process.env.EXTENSION_DIR ?? ROOT);
const OUT = path.join(ROOT, 'store/images');
const SHOP_PORT = 8080;
const RECEIVER_PORT = 6789;
const SHOP = `http://shop.example:${SHOP_PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browserOptions = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' };

// Icon palette.
const C = {
    slate: '#2b394a',
    slateDeep: '#1f2a37',
    coral: '#f2666e',
    sky: '#7acfe3',
    peach: '#fcd5b0',
    mist: '#a9b7c6',
};

// --- demo shop -------------------------------------------------------------------------------

const ORDERS = [
    { id: 1042, customer: 'Ada Lindqvist', items: 3, total: 128.4, status: 'paid' },
    { id: 1041, customer: 'Kenji Mori', items: 1, total: 42.0, status: 'pending' },
    { id: 1040, customer: 'Priya Raman', items: 5, total: 219.95, status: 'paid' },
    { id: 1039, customer: 'Tomás Ferreira', items: 2, total: 64.5, status: 'refunded' },
    { id: 1038, customer: 'Lena Fischer', items: 4, total: 156.0, status: 'paid' },
    { id: 1037, customer: 'Omar Haddad', items: 1, total: 19.99, status: 'pending' },
];

const SHOP_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Example Shop · Orders</title>
<style>
body{margin:0;font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f5f7fa;color:#1f2933}
header{background:#fff;border-bottom:1px solid #e4e7eb;padding:14px 24px;display:flex;align-items:center;gap:10px}
.logo{width:26px;height:26px;border-radius:7px;background:${C.coral}}
header h1{font-size:17px;margin:0}header nav{margin-left:18px;display:flex;gap:16px;color:#616e7c}
header nav b{color:#1f2933}
main{padding:18px 24px}
.cards{display:flex;gap:12px;margin-bottom:14px}
.card{flex:1;background:#fff;border:1px solid #e4e7eb;border-radius:10px;padding:11px 14px;color:#616e7c;font-size:12px}
.card b{display:block;font-size:20px;color:#1f2933;margin-top:2px}
table{width:100%;border-collapse:separate;border-spacing:0;background:#fff;border:1px solid #e4e7eb;border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid #eef0f3;font-size:13px}
th{color:#616e7c;font-weight:600;background:#fafbfc}tr:last-child td{border-bottom:0}
.pill{padding:2px 9px;border-radius:999px;font-size:12px}
.paid{background:#e3f9e5;color:#207227}.pending{background:#fff3c4;color:#8d5b00}.refunded{background:#e9eef5;color:#3e4c59}
</style></head><body>
<header><div class="logo"></div><h1>Example Shop</h1><nav><b>Orders</b><span>Products</span><span>Customers</span></nav></header>
<main>
<div class="cards"><div class="card">Revenue today<b id="revenue">…</b></div><div class="card">Orders<b id="count">…</b></div><div class="card">Pending<b id="pending">…</b></div></div>
<table><thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Status</th></tr></thead><tbody id="rows"></tbody></table>
</main>
<script>
const money = (n) => '$' + n.toFixed(2);
Promise.all([fetch('/api/orders?status=all&page=1').then((r) => r.json()), fetch('/api/stats').then((r) => r.json())])
  .then(([orders, stats]) => {
    document.getElementById('rows').innerHTML = orders.map((o) =>
      '<tr><td>#' + o.id + '</td><td>' + o.customer + '</td><td>' + o.items + '</td><td>' + money(o.total) +
      '</td><td><span class="pill ' + o.status + '">' + o.status + '</span></td></tr>').join('');
    document.getElementById('revenue').textContent = money(stats.revenue);
    document.getElementById('count').textContent = stats.orders;
    document.getElementById('pending').textContent = stats.pending;
  });
fetch('/api/me', { headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.demo' } });
setInterval(() => fetch('/api/notifications?since=' + Date.now()), 900);
window.addNote = () => fetch('/api/orders/1042/notes', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.demo' },
  body: JSON.stringify({ note: 'Gift wrap, please', notify: true }),
});
</script></body></html>`;

function startShop() {
    const json = (res, body, status = 200) =>
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, SHOP);
        if (url.pathname === '/orders') {
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Set-Cookie': 'session=7f3c9a1e2b; Path=/; HttpOnly',
            }).end(SHOP_PAGE);
        } else if (url.pathname === '/api/orders') {
            json(res, ORDERS);
        } else if (url.pathname === '/api/stats') {
            json(res, { revenue: 630.84, orders: 38, pending: 2 });
        } else if (url.pathname === '/api/me') {
            json(res, { id: 'u_204', name: 'Store admin', role: 'owner' });
        } else if (url.pathname === '/api/notifications') {
            json(res, { unread: 0, items: [] });
        } else if (url.pathname === '/api/orders/1042/notes') {
            req.resume();
            req.on('end', () => json(res, { id: 'n_88', created: true }, 201));
        } else {
            res.writeHead(404).end();
        }
    });
    return new Promise((resolve) => server.listen(SHOP_PORT, '127.0.0.1', () => resolve(server)));
}

// The command shown in the screenshots; the demo runs exactly this (from a temporary directory).
const RECEIVER_COMMAND = 'python3 examples/receiver.py --jsonl records.jsonl --har capture.har';

function startReceiver(work) {
    const child = spawn(
        'python3',
        [path.join(ROOT, 'examples/receiver.py'), '--jsonl', 'records.jsonl', '--har', 'capture.har'],
        {
            cwd: work,
        },
    );
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    return new Promise((resolve, reject) => {
        child.stderr.on(
            'data',
            (chunk) => String(chunk).includes('Listening') && resolve({ child, stdout: () => stdout }),
        );
        child.on('exit', (code) => reject(new Error(`receiver exited with ${code}`)));
    });
}

// --- capture the real popup and data ---------------------------------------------------------

async function captureDemo(work) {
    const jsonlPath = path.join(work, 'records.jsonl');
    const shop = await startShop();
    const receiver = await startReceiver(work);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-store-'));
    const context = await chromium.launchPersistentContext(profile, {
        ...browserOptions,
        headless: true,
        deviceScaleFactor: 2,
        args: [
            `--disable-extensions-except=${EXTENSION_DIR}`,
            `--load-extension=${EXTENSION_DIR}`,
            '--host-resolver-rules=MAP shop.example 127.0.0.1',
        ],
    });
    try {
        const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
        const extensionId = new URL(worker.url()).host;

        const page = await context.newPage();
        await page.setViewportSize({ width: 800, height: 520 });
        await page.goto(`${SHOP}/orders`);

        const popup = await context.newPage();
        await popup.setViewportSize({ width: 340, height: 900 });
        await popup.goto(`chrome-extension://${extensionId}/popup.html`);
        await popup.evaluate(() => chrome.storage.local.set({ reloadOnStart: true }));
        await popup.reload();
        await popup.waitForFunction(() => document.getElementById('tab').options.length > 0);
        const tabId = await popup.evaluate(async () => (await chrome.tabs.query({ title: 'Example Shop*' }))[0].id);
        await popup.selectOption('#tab', String(tabId));
        await popup.click('#toggle');
        await sleep(4000);
        await page.screenshot({ path: path.join(work, 'shop.png') });
        await popup.locator('body').screenshot({ path: path.join(work, 'popup-capturing.png') });
        const forwardedAtShot = Number(/(\d+) forwarded/.exec(await popup.textContent('#status'))?.[1] ?? 0);

        // Options as a cautious user would set them, then a request that shows redaction.
        await popup.click('#options summary');
        await popup.check('[data-setting="redact"]');
        await popup.fill('[data-setting="includeUrls"]', '*/api/*');
        await popup.fill('[data-setting="excludeUrls"]', '/api/notifications');
        await popup.fill('[data-setting="maxBodyKB"]', '512');
        await popup.dispatchEvent('[data-setting="maxBodyKB"]', 'change');
        await popup.evaluate(() => document.activeElement.blur());
        await sleep(600);
        await page.evaluate(() => window.addNote());
        await sleep(1200);
        await popup.locator('body').screenshot({ path: path.join(work, 'popup-options.png') });

        const records = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').map(JSON.parse);
        return { records, receiverLines: receiver.stdout().trim().split('\n'), forwardedAtShot };
    } finally {
        await context.close();
        receiver.child.kill();
        shop.close();
        fs.rmSync(profile, { recursive: true, force: true });
    }
}

// --- layouts ---------------------------------------------------------------------------------

const dataUrl = (file) => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const BASE_CSS = `
*{box-sizing:border-box}
html,body{margin:0;width:100%;height:100%}
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff;overflow:hidden;
  background:radial-gradient(1200px 700px at 85% 15%, #34475c 0%, ${C.slate} 45%, ${C.slateDeep} 100%)}
h1{margin:0;font-size:40px;line-height:1.15;font-weight:700;letter-spacing:-0.01em}
.sub{margin-top:10px;font-size:19px;color:${C.mist}}
.window{position:absolute;border-radius:12px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.45),0 2px 0 rgba(255,255,255,.04) inset}
.term{background:#11171f;font:12.5px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;color:#d7dee6}
.term .bar{height:30px;background:#1a222c;display:flex;align-items:center;padding:0 12px;gap:7px}
.dot{width:11px;height:11px;border-radius:50%}
.term .lines{padding:12px 16px}
.term .line{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.prompt{color:${C.sky}}.ok{color:#8bd49c}.dim{color:#6b7a8c}
.popup{position:absolute;border-radius:10px;box-shadow:0 18px 50px rgba(0,0,0,.5);background:#fff}
`;

const dots = `<span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span>`;

function terminal({ x, y, w, lines }) {
    return `<div class="window term" style="left:${x}px;top:${y}px;width:${w}px">
<div class="bar">${dots}</div><div class="lines">${lines.map((l) => `<div class="line">${l}</div>`).join('')}</div></div>`;
}

function receiverLine(line) {
    const m = line.match(/^(\d{3}|---) (\S+)\s+(\S+)\s+\((.*)\)$/);
    if (!m) {
        return esc(line);
    }
    const [, status, method, url, rest] = m;
    return `<span class="ok">${status}</span> ${esc(method.padEnd(5)).replace(/ /g, '&nbsp;')} ${esc(url.replace(SHOP, ''))} <span class="dim">${esc(rest)}</span>`;
}

function hero({ shop, popup, receiverLines }) {
    const polls = receiverLines.filter((l) => l.includes('/api/notifications'));
    const lines = [
        `<span class="prompt">$</span> ${RECEIVER_COMMAND}`,
        `<span class="dim">Listening on http://127.0.0.1:${RECEIVER_PORT}</span>`,
        ...receiverLines
            .filter((l) => !l.includes('/api/notifications'))
            .slice(0, 4)
            .map(receiverLine),
        ...polls.slice(0, 1).map(receiverLine),
    ];
    return `<style>${BASE_CSS}
.browser{left:64px;top:178px;width:800px;height:560px;background:#fff}
.chrome{height:40px;background:#e9edf2;display:flex;align-items:center;padding:0 12px;gap:7px}
.url{margin-left:14px;flex:1;height:26px;border-radius:13px;background:#fff;color:#52606d;font-size:13px;display:flex;align-items:center;padding:0 14px}
.ext{position:relative;width:26px;height:26px;margin-left:10px}
.ext img{width:26px;height:26px}
.badge{position:absolute;right:-7px;bottom:-5px;background:#1a73e8;color:#fff;font-size:10px;font-weight:700;border-radius:8px;padding:0 4px;line-height:14px}
</style>
<div style="position:absolute;left:64px;top:56px">
  <h1>Stream a tab's network traffic to your own server</h1>
  <div class="sub">Requests, responses, cookies and bodies, as JSON, while you browse.</div>
</div>
<div class="window browser">
  <div class="chrome">${dots}<div class="url">shop.example:${SHOP_PORT}/orders</div>
    <div class="ext"><img src="${dataUrl(path.join(ROOT, 'images/icon-32.png'))}"><span class="badge">${popup.count}</span></div></div>
  <img src="${shop}" style="display:block;width:800px;height:520px">
</div>
<img class="popup" src="${popup.src}" style="left:${800 + 64 - 340 + 12}px;top:${178 + 46}px;width:340px">
${terminal({ x: 596, y: 560, w: 620, lines })}`;
}

function options({ popup }) {
    const feature = (color, title, text) =>
        `<div style="display:flex;gap:14px;margin-bottom:26px"><span style="flex:none;width:12px;height:12px;border-radius:50%;margin-top:9px;background:${color}"></span>
<div><div style="font-size:22px;font-weight:600">${title}</div><div style="font-size:17px;color:${C.mist};margin-top:4px">${text}</div></div></div>`;
    return `<style>${BASE_CSS}</style>
<div style="position:absolute;left:72px;top:50%;transform:translateY(-50%);width:620px">
  <h1>Decide what leaves the browser</h1>
  <div class="sub" style="margin-bottom:46px">All options apply immediately, even mid-capture.</div>
  ${feature(C.sky, 'Filter', 'By resource type, URL pattern and HTTP method.')}
  ${feature(C.peach, 'Trim', 'Replace bodies over a size limit with a marker.')}
  ${feature(C.coral, 'Redact', 'Strip cookies and auth headers before sending.')}
  ${feature('#8bd49c', 'Catch page loads', 'Reload the page when capture starts.')}
</div>
<img class="popup" src="${popup.src}" style="left:${1280 - 72 - 340}px;top:${(800 - popup.height) / 2}px;width:340px">`;
}

/** Colors one JSON value: strings peach, numbers and literals pink. */
function highlightValue(json) {
    const color = json.startsWith('"') ? C.peach : '#f2a7ab';
    return `<span style="color:${color}">${esc(json)}</span>`;
}

function data({ record, receiverLines }) {
    // A compact excerpt of the real record: every value comes from it; "…" marks fields left out.
    const v = (value) => highlightValue(JSON.stringify(value));
    const k = (name) => `<span style="color:${C.sky}">"${name}"</span>`;
    const { request, response, cookies, response_body: body } = record;
    const session = cookies.find((c) => c.name === 'session');
    const code = [
        '{',
        `  ${k('schema_version')}: ${v(record.schema_version)},`,
        `  ${k('resource_type')}: ${v(record.resource_type)},`,
        `  ${k('timestamp')}: ${v(record.timestamp)},`,
        `  ${k('duration_ms')}: ${v(record.duration_ms)},`,
        `  ${k('request')}: {`,
        `    ${k('method')}: ${v(request.method)},`,
        `    ${k('url')}: ${v(request.url)},`,
        `    ${k('headers')}: {`,
        `      ${k('Authorization')}: ${v(request.headers.Authorization)},`,
        `      ${k('Content-Type')}: ${v(request.headers['Content-Type'])}, <span class="dim">…</span>`,
        '    },',
        `    ${k('postData')}: ${v(request.postData)}`,
        '  },',
        `  ${k('response')}: { ${k('status')}: ${v(response.status)}, ${k('mimeType')}: ${v(response.mimeType)}, <span class="dim">…</span> },`,
        `  ${k('cookies')}: [{ ${k('name')}: ${v(session.name)}, ${k('value')}: ${v(session.value)}, <span class="dim">…</span> }],`,
        `  ${k('response_body')}: {`,
        `    ${k('body')}: ${v(body.body)},`,
        `    ${k('base64Encoded')}: ${v(body.base64Encoded)}`,
        '  }',
        '}',
    ].join('\n');
    const lines = [
        `<span class="prompt">$</span> ${RECEIVER_COMMAND}`,
        `<span class="dim">Listening on http://127.0.0.1:${RECEIVER_PORT}</span>`,
        ...receiverLines
            .filter((l) => !l.includes('/api/notifications'))
            .slice(-5)
            .map(receiverLine),
    ];
    return `<style>${BASE_CSS}
.code{left:64px;top:178px;width:700px;background:#11171f;padding:22px 26px;font:13px/1.75 ui-monospace,SFMono-Regular,Menlo,monospace;color:#d7dee6;white-space:pre}
</style>
<div style="position:absolute;left:64px;top:56px">
  <h1>Plain JSON your code can use</h1>
  <div class="sub">One POST per request. Run the bundled receiver, or point it at any endpoint.</div>
</div>
<div class="window code">${code}</div>
${terminal({ x: 796, y: 178, w: 420, lines })}
<div style="position:absolute;left:796px;top:430px;width:420px;font-size:18px;color:${C.mist};line-height:1.7">
  <div style="color:#fff;font-weight:600;font-size:21px;margin-bottom:6px">Take it anywhere</div>
  Save JSONL or HAR, open captures in DevTools, feed tests, mocks and scripts.
</div>`;
}

const PIPE = (w) => `<svg width="${w}" height="64" viewBox="0 0 ${w} 64" fill="none">
<rect x="0" y="26" width="${w - 40}" height="12" rx="6" fill="${C.coral}"/>
${[0.12, 0.3, 0.48, 0.66]
    .map(
        (f, i) =>
            `<circle cx="${Math.round(f * (w - 60))}" cy="32" r="${i % 2 ? 9 : 7}" fill="${i % 2 ? C.sky : C.peach}"/>`,
    )
    .join('')}
<rect x="${w - 46}" y="8" width="46" height="48" rx="8" fill="${C.sky}"/>
<rect x="${w - 38}" y="18" width="30" height="5" rx="2.5" fill="${C.slate}"/>
<rect x="${w - 38}" y="29" width="30" height="5" rx="2.5" fill="${C.slate}"/>
<rect x="${w - 38}" y="40" width="30" height="5" rx="2.5" fill="${C.slate}"/>
</svg>`;

function smallTile() {
    return `<style>${BASE_CSS} body{background:linear-gradient(135deg, ${C.slate} 0%, ${C.slateDeep} 100%)}</style>
<div style="position:absolute;left:32px;top:34px;display:flex;align-items:center;gap:18px">
  <div style="width:112px;height:112px;border-radius:24px;background:#fff;display:grid;place-items:center">
    <img src="${dataUrl(path.join(ROOT, 'images/icon-128.png'))}" style="width:96px;height:96px"></div>
  <div style="font-size:34px;font-weight:700;line-height:1.08">Request<br>Pipeline</div>
</div>
<div style="position:absolute;left:32px;bottom:34px">${PIPE(376)}</div>`;
}

function marquee() {
    const pill = (method, p, color, x, y) =>
        `<div style="position:absolute;left:${x}px;top:${y}px;background:#fff;color:${C.slateDeep};border-radius:12px;padding:10px 16px;font:600 19px ui-monospace,Menlo,monospace;box-shadow:0 10px 30px rgba(0,0,0,.3)"><span style="color:${color}">${method}</span> ${p}</div>`;
    return `<style>${BASE_CSS} body{background:linear-gradient(120deg, ${C.slate} 0%, ${C.slateDeep} 100%)}</style>
<div style="position:absolute;left:96px;top:150px;display:flex;align-items:center;gap:30px">
  <div style="width:150px;height:150px;border-radius:32px;background:#fff;display:grid;place-items:center">
    <img src="${dataUrl(path.join(ROOT, 'images/icon-128.png'))}" style="width:128px;height:128px"></div>
  <div><div style="font-size:64px;font-weight:700;line-height:1.05">Request Pipeline</div>
  <div style="font-size:26px;color:${C.mist};margin-top:12px">Your browser's network traffic, streamed to your own server</div></div>
</div>
<div style="position:absolute;left:96px;bottom:70px">${PIPE(1208)}</div>
${pill('GET', '/api/orders', '#207227', 560, 435)}
${pill('POST', '/api/notes', '#c2410c', 880, 435)}`;
}

// --- main ------------------------------------------------------------------------------------

async function render(browser, html, width, height, file) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: path.join(OUT, file) });
    await page.close();
    console.log(`  store/images/${file} (${width}x${height})`);
}

async function main() {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-store-work-'));
    try {
        const { version } = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
        console.log(`Capturing the demo with extension ${version} from ${EXTENSION_DIR}`);
        const { records, receiverLines, forwardedAtShot } = await captureDemo(work);
        const note = records.find((r) => r.request.url.endsWith('/api/orders/1042/notes'));
        if (!note) {
            throw new Error('the POST /api/orders/1042/notes record was not captured');
        }
        const popupSize = (file) => {
            const png = fs.readFileSync(file);
            return { src: dataUrl(file), height: png.readUInt32BE(20) / 2 };
        };
        const capturing = { ...popupSize(path.join(work, 'popup-capturing.png')), count: forwardedAtShot };

        fs.mkdirSync(OUT, { recursive: true });
        const browser = await chromium.launch(browserOptions);
        try {
            await render(
                browser,
                hero({ shop: dataUrl(path.join(work, 'shop.png')), popup: capturing, receiverLines }),
                1280,
                800,
                'screenshot-1-capture.png',
            );
            await render(
                browser,
                options({ popup: popupSize(path.join(work, 'popup-options.png')) }),
                1280,
                800,
                'screenshot-2-options.png',
            );
            await render(browser, data({ record: note, receiverLines }), 1280, 800, 'screenshot-3-json.png');
            await render(browser, smallTile(), 440, 280, 'promo-small-440x280.png');
            await render(browser, marquee(), 1400, 560, 'promo-marquee-1400x560.png');
        } finally {
            await browser.close();
        }
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}

await main();
