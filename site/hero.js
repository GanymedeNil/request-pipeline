// Animates the hero: requests fill the tab's waterfall, and each finished one drops down the pipe
// into the receiver, which prints the line examples/receiver.py would print. The HTML already shows
// the finished state, so without JavaScript or with reduced motion nothing needs to happen.

const REQUESTS = [
    { method: 'GET', path: '/orders', status: 200, width: 30, detail: '(text/html, 2.8 KB, 11 ms)' },
    { method: 'GET', path: '/api/orders?page=1', status: 200, width: 72, detail: '(application/json, 474 B, 84 ms)' },
    { method: 'GET', path: '/api/stats', status: 200, width: 34, detail: '(application/json, 42 B, 31 ms)' },
    { method: 'GET', path: '/api/me', status: 200, width: 44, detail: '(application/json, 50 B, 46 ms)' },
    {
        method: 'POST',
        path: '/api/orders/1042/notes',
        status: 201,
        width: 96,
        detail: '(application/json, 28 B, 120 ms)',
    },
];

const HEADER =
    '<span class="prompt">$</span> python3 examples/receiver.py\n' +
    '<span class="dim">Listening on http://127.0.0.1:6789</span>';

const waterfall = document.getElementById('waterfall');
const pipe = document.getElementById('pipe');
const term = document.getElementById('term');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

async function send(request) {
    const row = el('li');
    const status = el('span', 'status', '···');
    const fill = el('span');
    const bar = el('span', 'bar');
    bar.append(fill);
    row.append(el('span', 'method', request.method), el('span', 'path', request.path), status, bar);
    fill.style.width = '0%';
    fill.style.transition = `width ${300 + request.width * 7}ms ease-out`;
    waterfall.append(row);

    await wait(30);
    fill.style.width = `${request.width}%`;
    await wait(300 + request.width * 7);
    status.textContent = String(request.status);
    row.classList.add('sent');

    const packet = el('span', 'packet');
    pipe.append(packet);
    await packet.animate([{ transform: 'translateY(0)' }, { transform: `translateY(${pipe.clientHeight - 10}px)` }], {
        duration: 650,
        easing: 'ease-in',
    }).finished;
    packet.remove();

    const line = document.createElement('span');
    const method = request.method.padEnd(4, ' ');
    line.innerHTML = `\n<span class="ok">${request.status}</span> ${method} ${request.path} <span class="dim">${request.detail}</span>`;
    line.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 250 });
    term.append(line);
}

async function loop() {
    while (!reduceMotion.matches) {
        waterfall.replaceChildren();
        term.innerHTML = HEADER;
        await wait(500);
        const sends = [];
        for (const request of REQUESTS) {
            sends.push(send(request));
            await wait(520);
        }
        await Promise.all(sends);
        await wait(3200);
    }
}

if (waterfall && pipe && term && !reduceMotion.matches && 'animate' in Element.prototype) {
    loop();
}
