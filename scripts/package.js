// Builds dist/request-pipeline-<version>.zip for the Chrome Web Store.
//
// The file list isn't maintained by hand: it starts at manifest.json and follows what the extension
// actually loads (icons, the service worker, the popup, their <script>/<link> tags and their
// imports). A reference to a missing file fails the build, and tests, examples or docs can't end
// up in the package.
//
// Usage: node scripts/package.js [--out <dir>]

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Returns the extension's files, relative to `root` with forward slashes, sorted.
 * @param {string} root
 * @returns {string[]}
 */
export function collectFiles(root) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const start = [
        'manifest.json',
        ...Object.values(manifest.icons ?? {}),
        ...Object.values(manifest.action?.default_icon ?? {}),
        manifest.background?.service_worker,
        manifest.action?.default_popup,
    ].filter(Boolean);

    const found = new Set();
    const queue = start.map((file) => path.posix.normalize(file));
    while (queue.length > 0) {
        const file = /** @type {string} */ (queue.shift());
        if (found.has(file)) {
            continue;
        }
        const full = path.join(root, file);
        if (!fs.existsSync(full)) {
            throw new Error(`${file} is referenced but does not exist`);
        }
        found.add(file);
        for (const ref of references(file, fs.readFileSync(full, 'utf8'))) {
            queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), ref)));
        }
    }
    return [...found].sort();
}

/**
 * Local files a page or module loads. Only relative paths count; JSDoc `import()` types are inside
 * comments and don't start a line, so they aren't matched.
 * @param {string} file
 * @param {string} text
 * @returns {string[]}
 */
function references(file, text) {
    const patterns = {
        '.html': [/<script[^>]+src="([^"]+)"/g, /<link[^>]+href="([^"]+)"/g],
        '.js': [/^\s*(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]/gm, /^\s*import\s*['"]([^'"]+)['"]/gm],
    }[path.extname(file)];
    if (!patterns) {
        return [];
    }
    return patterns
        .flatMap((re) => [...text.matchAll(re)].map((m) => m[1]))
        .filter((ref) => ref.startsWith('./') || ref.startsWith('../'));
}

/**
 * A minimal, deterministic ZIP writer (deflate, fixed timestamps, UTF-8 names).
 * @param {{ name: string, data: Buffer }[]} entries
 * @returns {Buffer}
 */
export function createZip(entries) {
    const DOS_TIME = 0;
    const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
    const UTF8 = 0x0800;
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const { name, data } of entries) {
        const nameBuf = Buffer.from(name, 'utf8');
        const compressed = zlib.deflateRawSync(data, { level: 9 });
        const crc = zlib.crc32(data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(UTF8, 6);
        local.writeUInt16LE(8, 8);
        local.writeUInt16LE(DOS_TIME, 10);
        local.writeUInt16LE(DOS_DATE, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, nameBuf, compressed);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, spec 2.0
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(UTF8, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt16LE(DOS_TIME, 12);
        central.writeUInt16LE(DOS_DATE, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBuf);

        offset += local.length + nameBuf.length + compressed.length;
    }

    const centralDir = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralDir.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralDir, end]);
}

function main() {
    const outIndex = process.argv.indexOf('--out');
    const outDir = path.resolve(outIndex > 0 ? process.argv[outIndex + 1] : path.join(ROOT, 'dist'));
    const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

    const files = collectFiles(ROOT);
    const zip = createZip(files.map((name) => ({ name, data: fs.readFileSync(path.join(ROOT, name)) })));
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `request-pipeline-${version}.zip`);
    fs.writeFileSync(outFile, zip);

    console.log(files.map((f) => `  ${f}`).join('\n'));
    console.log(
        `${path.relative(process.cwd(), outFile)}: ${files.length} files, ${(zip.length / 1024).toFixed(1)} KB`,
    );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
