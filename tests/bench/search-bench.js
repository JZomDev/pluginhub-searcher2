// Search latency benchmark over a built index.
// node --expose-gc tests/bench/search-bench.js <index-dir> [none|fast] [searcher-module]
// BENCH_WORKERS=<n> scans on n worker threads (the current searcher only).
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const [indexDirectory, profileName = 'none', modulePath = path.join(__dirname, '..', '..', 'scripts', 'reverse-search-browser.js')] = process.argv.slice(2);
// [round trip ms, bytes per second] of one shared connection.
const PROFILES = { none: [0, Infinity], fast: [20, 50e6 / 8] };
if (!indexDirectory || !PROFILES[profileName]) {
    console.error('Usage: node --expose-gc tests/bench/search-bench.js <index-dir> [none|fast] [searcher-module]');
    process.exit(2);
}
const { BrowserReverseSearcher } = require(path.resolve(modulePath));
const [roundTripMs, bytesPerSecond] = PROFILES[profileName];

const QUERIES = [
    ['rare literal', 'ToaKerisCam', {}],
    ['default', 'Toa Keris Cam', { isRegex: true }],
    ['common literal', 'client', {}],
    ['common 2-char', 'if', {}],
    ['regex no literal', 'a|b', { isRegex: true }],
    ['regex w/ literal', 'onGameTick\\(.*\\)', { isRegex: true }],
    ['very common', 'import net.runelite', {}],
    ['case-sensitive', 'getLocalPlayer', { caseSensitive: true }]
];

// Serves index files from disk as if over one connection: each request waits
// one round trip, and transfers share the bandwidth one after another.
function networkFetch(stats) {
    let linkFreeAt = 0;
    return async url => {
        const relative = new URL(url).pathname.replace(/^\/index\//, '');
        const bytes = fs.readFileSync(path.join(indexDirectory, relative));
        stats.requests++;
        stats.bytes += bytes.length;
        const now = performance.now();
        const doneAt = Math.max(now + roundTripMs, linkFreeAt) + bytes.length / bytesPerSecond * 1000;
        linkFreeAt = doneAt;
        await new Promise(resolve => setTimeout(resolve, doneAt - now));
        return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    };
}

// Order-insensitive fingerprint of a search result, to prove two versions agree.
function digest({ results, lineCount, plugins }) {
    const rows = results.map(result => [result.plugin, result.repository, result.commit, result.filePath, result.line, result.content]);
    const counts = plugins.map(({ plugin, lines }) => [plugin, lines]).sort((left, right) => left[0].localeCompare(right[0]));
    return crypto.createHash('sha256').update(JSON.stringify([rows, lineCount, counts])).digest('hex').slice(0, 12);
}

async function measure(searcher, query, options, stats) {
    global.gc?.();
    let peak = 0;
    const sample = () => {
        const usage = process.memoryUsage();
        peak = Math.max(peak, usage.heapUsed + usage.external);
    };
    const timer = setInterval(sample, 20);
    stats.requests = 0;
    stats.bytes = 0;
    const start = performance.now();
    const found = await searcher.search(query, { limit: 5000, ...options });
    const ms = performance.now() - start;
    clearInterval(timer);
    sample();
    return { ms, found, peak, requests: stats.requests, bytes: stats.bytes };
}

function print(kind, name, { ms, found, peak, requests, bytes }) {
    console.log(`${kind} ${name.padEnd(17)} ${ms.toFixed(0).padStart(6)}ms req=${String(requests).padStart(4)} ` +
        `MB=${(bytes / 1e6).toFixed(2).padStart(6)} peakMB=${(peak / 1e6).toFixed(0).padStart(4)} ` +
        `lines=${found.lineCount} digest=${digest(found)}`);
}

// Searcher options for BENCH_WORKERS worker threads, and a close() that stops them.
function workerOptions() {
    const count = Number(process.env.BENCH_WORKERS || 0);
    if (!count) return { options: {}, close() {} };
    const { Worker } = require('node:worker_threads');
    const threads = [];
    const createWorker = () => {
        const thread = new Worker(path.join(__dirname, 'node-scan-worker.js'));
        threads.push(thread);
        const shim = { onmessage: null, onerror: null, postMessage: message => thread.postMessage(message), terminate: () => thread.terminate() };
        thread.on('message', data => shim.onmessage?.({ data }));
        thread.on('error', error => shim.onerror?.(error));
        return shim;
    };
    return { options: { createWorker, poolSize: count }, close: () => threads.forEach(thread => thread.terminate()) };
}

(async () => {
    console.log(`profile=${profileName} module=${path.relative(process.cwd(), path.resolve(modulePath))} workers=${process.env.BENCH_WORKERS || 0}`);
    for (const [name, query, options] of QUERIES) {
        const stats = { requests: 0, bytes: 0 };
        const workers = workerOptions();
        const searcher = new BrowserReverseSearcher('https://bench.example/index/', networkFetch(stats), workers.options);
        await searcher.load();
        print('cold', name, await measure(searcher, query, options, stats));
        print('warm', name, await measure(searcher, query, options, stats));
        workers.close();
    }
    process.exit(0);
})();
