// Sends one record to the receiver.

/** @typedef {import('./record.js').ForwardedRecord} ForwardedRecord */

/**
 * POSTs `record` as JSON. Never throws: network errors and non-2xx answers come back as `ok: false`.
 * @param {string} server
 * @param {ForwardedRecord} record
 * @returns {Promise<{ ok: true } | { ok: false, message: string }>}
 */
export async function forward(server, record) {
    try {
        const res = await fetch(server, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(record),
        });
        return res.ok ? { ok: true } : { ok: false, message: `HTTP ${res.status}` };
    } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
}
