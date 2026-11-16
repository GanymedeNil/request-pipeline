import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { collectFiles, createZip } from '../scripts/package.js';

const ROOT = path.resolve(import.meta.dirname, '..');

test('the package contains exactly what the extension loads', () => {
    assert.deepEqual(collectFiles(ROOT), [
        'background.js',
        'config.js',
        'images/icon-128.png',
        'images/icon-16.png',
        'images/icon-32.png',
        'images/icon-48.png',
        'lib/filter.js',
        'lib/forward.js',
        'lib/record.js',
        'lib/redact.js',
        'manifest.json',
        'popup.css',
        'popup.html',
        'popup.js',
    ]);
});

test('a missing referenced file fails the build', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-package-'));
    try {
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ background: { service_worker: 'bg.js' } }));
        fs.writeFileSync(path.join(dir, 'bg.js'), "import { x } from './lib/missing.js';\n");
        assert.throws(() => collectFiles(dir), /lib\/missing\.js is referenced but does not exist/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// Reads entries back through the central directory, the way unzip tools do.
function readZip(zip) {
    const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const count = zip.readUInt16LE(end + 10);
    let pos = zip.readUInt32LE(end + 16);
    const entries = [];
    for (let i = 0; i < count; i++) {
        assert.equal(zip.readUInt32LE(pos), 0x02014b50);
        const crc = zip.readUInt32LE(pos + 16);
        const size = zip.readUInt32LE(pos + 20);
        const nameLength = zip.readUInt16LE(pos + 28);
        const localOffset = zip.readUInt32LE(pos + 42);
        const name = zip.toString('utf8', pos + 46, pos + 46 + nameLength);
        const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
        const data = zlib.inflateRawSync(zip.subarray(dataStart, dataStart + size));
        assert.equal(zlib.crc32(data), crc, `crc of ${name}`);
        entries.push({ name, data: data.toString('utf8') });
        pos += 46 + nameLength;
    }
    return entries;
}

test('the zip round-trips names and contents and is deterministic', () => {
    const entries = [
        { name: 'manifest.json', data: Buffer.from('{"name":"x"}') },
        { name: 'lib/ünïcode.js', data: Buffer.from('export const a = 1;\n'.repeat(100)) },
        { name: 'empty.txt', data: Buffer.alloc(0) },
    ];
    const zip = createZip(entries);

    assert.deepEqual(
        readZip(zip),
        entries.map(({ name, data }) => ({ name, data: data.toString('utf8') })),
    );
    assert.ok(zip.equals(createZip(entries)), 'same input, same bytes');
});
