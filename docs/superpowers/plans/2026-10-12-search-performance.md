# Search Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make browser searches faster (a cheaper scan, scanning on Web Workers) and make return visits load the index from a persistent cache, with results identical to today's.

**Architecture:** A new pure `scan-core.js` holds the chunk scan and is shared by a Web Worker (`scan-worker.js`) and the in-thread fallback. `scan-pool.js` dispatches chunk scans to the workers, and `index-cache.js` wraps the Cache API. `BrowserReverseSearcher` keeps its public API and wires these in, falling back to in-thread scanning and in-memory caching wherever a browser feature is missing (including Node tests).

**Tech Stack:** Plain browser JavaScript (UMD-style IIFE modules, no bundler), Web Workers, Cache API, `DecompressionStream`; tests with `node --test` on Node 20; the index builder is Python 3.

**Spec:** `docs/superpowers/specs/2026-10-12-search-performance-design.md`

## Global Constraints

- The index format does not change. Do not edit `builders/`, `plugins/data/` or `.github/workflows/`.
- Results must be identical to the current implementation for the same query and options.
- The `BrowserReverseSearcher` public API stays: `load()`, `prefetch()`, `search()`, `manifest`, `loadedFiles`, and the `requiredRegexLiterals` export. The constructor only gains an optional third `options` argument.
- Pool size is `min(4, hardwareConcurrency - 1)`, minimum 1.
- Workers do not keep decoded text between searches. The decoded-chunk LRU is removed.
- Persistent cache: one Cache API cache per index build, named `pluginhub-index-<build>`. Caches of other builds are deleted on load.
- Static hosting only (GitHub Pages). The workflows copy `index.html` and `scripts/` wholesale, so new files must live in `scripts/`.
- Every module follows the existing UMD pattern: `(function (root) { 'use strict'; ... })(typeof globalThis !== 'undefined' ? globalThis : this);`, exporting through `module.exports` under Node and a `root.<Name>` global in the browser.
- Node is not on `PATH` in this environment. Prefix commands with `export PATH=$HOME/.nvm/versions/node/v20.20.2/bin:$PATH && `.
- Commit messages contain no Claude attribution: no `Co-Authored-By`, no `Claude-Session`, no "Generated with" lines.

## Spec deviations (deliberate)

1. The pool and the cache are their own files (`scripts/scan-pool.js`, `scripts/index-cache.js`) rather than more code in `reverse-search-browser.js`. Each one is then small, injectable and testable on its own.
2. The fast literal path runs only when the search is case-sensitive or the file is ASCII-only, and the file has no lone `\r`. Every other file takes today's per-line path. This is stricter than the spec's "lowercased length differs" rule, and it guarantees identical offsets and line numbers.
3. The regex required-literal prefilter is applied only to case-sensitive regexes. Case-insensitive regex matching uses case folding, which a lowercase `includes` check cannot mirror exactly.

## Review Focus

1. An empty query (`search('')`, possible through the API) must match every line as it does today and never loop forever in `indexOf('')`. The test is in Task 2.
2. Source files with lone `\r` or mixed line endings must report the same line numbers and line text as today. The test is in Task 2.
3. Case-insensitive search over non-ASCII text (`İ`, `Σ`, emoji) must return exactly what it does today. The test is in Task 2.
4. If storage is full or the Cache API is unavailable (Firefox private windows), search must still work, just without persistence. The test is in Task 4.
5. If the user edits a query mid-search, aborting while workers are still busy and starting a new search, no lines from the old search may appear in the new one. The test is in Task 5.

## File structure

| File | Responsibility |
|---|---|
| `scripts/scan-core.js` (new) | Decode one gzip JSON text chunk and scan it for one query. Pure; no state. |
| `scripts/scan-worker.js` (new) | Worker shell: receive `{ id, task }`, run `ScanCore.scanBytes`, reply `{ id, result }` or `{ id, error }`. |
| `scripts/scan-pool.js` (new) | `ScanPool`: queue tasks onto workers; retry failures in-thread; drop crashed workers. |
| `scripts/index-cache.js` (new) | `IndexCache`: per-build Cache API store; every failure behaves as a miss. |
| `scripts/reverse-search-browser.js` (modify) | Wires scan-core, the pool and the cache into `BrowserReverseSearcher`. |
| `index.html` (modify) | Script tags for the new browser modules. |
| `tests/scan-core.test.js` (new) | Parity tests against the old per-line scan. |
| `tests/scan-pool.test.js` (new) | Pool behaviour with fake workers. |
| `tests/index-cache.test.js` (new) | Cache behaviour with a fake CacheStorage. |
| `tests/fake-cache-storage.js` (new) | In-memory CacheStorage stand-in shared by tests. |
| `tests/fake-workers.js` (new) | Web Worker stand-in shared by tests. |
| `tests/reverse-search.test.js` (modify) | Searcher-level tests for refetch, cache and workers. |
| `tests/bench/search-bench.js` (new) | Latency, request, memory and result-digest benchmark. |
| `tests/bench/node-scan-worker.js` (new) | worker_threads stand-in for `scan-worker.js`, used only by the benchmark. |
| `.gitignore` (modify) | Ignore `/bench-results/`. |

`npm test` runs `node --test tests/*.test.js`, so the helper and bench files (not named `*.test.js`) are not run as tests.

---

### Task 1: Benchmark harness and baseline

**Files:**
- Create: `tests/bench/search-bench.js`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `BrowserReverseSearcher(indexUrl, fetchFunction)` from any searcher module path.
- Produces: `node --expose-gc tests/bench/search-bench.js <index-dir> [none|fast] [searcher-module]`, which prints one line per query and run (`cold` or `warm`) with `ms`, `req`, `MB`, `peakMB`, `lines` and `digest=<12 hex>`. Baseline outputs are saved in `bench-results/baseline-none.txt` and `bench-results/baseline-fast.txt`. Later tasks compare their digests to these.

- [ ] **Step 1: Ignore benchmark output**

Append this line to `.gitignore`:

```
/bench-results/
```

- [ ] **Step 2: Write the benchmark**

Create `tests/bench/search-bench.js`:

```js
// Search latency benchmark over a built index.
// node --expose-gc tests/bench/search-bench.js <index-dir> [none|fast] [searcher-module]
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

(async () => {
    console.log(`profile=${profileName} module=${path.relative(process.cwd(), path.resolve(modulePath))}`);
    for (const [name, query, options] of QUERIES) {
        const stats = { requests: 0, bytes: 0 };
        const searcher = new BrowserReverseSearcher('https://bench.example/index/', networkFetch(stats));
        await searcher.load();
        print('cold', name, await measure(searcher, query, options, stats));
        print('warm', name, await measure(searcher, query, options, stats));
    }
    process.exit(0);
})();
```

- [ ] **Step 3: Build the index and record the baseline**

Run:

```bash
export PATH=$HOME/.nvm/versions/node/v20.20.2/bin:$PATH
python3 builders/build_reverse_index.py plugins/data plugins/index
mkdir -p bench-results
git show main:scripts/reverse-search-browser.js > bench-results/baseline-searcher.js
node --expose-gc tests/bench/search-bench.js plugins/index none bench-results/baseline-searcher.js | tee bench-results/baseline-none.txt
node --expose-gc tests/bench/search-bench.js plugins/index fast bench-results/baseline-searcher.js | tee bench-results/baseline-fast.txt
```

Expected: 16 result lines per profile. Cold `rare literal` is about 80 ms with no network cost, and cold `common literal` is about 1.8 s with no network cost or about 12 s on `fast`. The `digest=` values are the same in both files for the same query. Delete any stale `plugins/index/bench.js` left over from the probe, because the build wipes `plugins/index` anyway.

- [ ] **Step 4: Commit**

```bash
git add .gitignore tests/bench/search-bench.js
git commit -m "Add search benchmark harness"
```

---

### Task 2: scan-core

**Files:**
- Create: `scripts/scan-core.js`
- Test: `tests/scan-core.test.js`

**Interfaces:**
- Consumes: `requiredRegexLiterals(source)` from `scripts/reverse-search-browser.js` (tests only).
- Produces (`module.exports` under Node and `root.ScanCore` in the browser and worker):
  - `gunzip(bytes: Uint8Array): Promise<Uint8Array>`
  - `decodeChunk(bytes: Uint8Array): Promise<Array<[pluginIndex: number, filePath: string, content: string]>>`
  - `scanChunk(files, first: number, fileIds: number[] | null, query: ScanQuery): ScanResult`
  - `scanBytes(task: { bytes: Uint8Array, first: number, fileIds: number[] | null, query: ScanQuery }): Promise<ScanResult>`
  - `keepTop(matches: Match[], limit: number): Match[]`: sorts in place by `compareMatches` and truncates to `limit`.
  - `compareMatches(left, right)`: higher `priority` first, then `fileId`, then `line`.
  - `ScanQuery = { needle: string, caseSensitive: boolean, isRegex: boolean, limit: number, ranks: number[], literals: string[] | null }`. Here `ranks[pluginIndex]` is the priority, and `literals` holds the regex required literals (or null). It must be structured-cloneable, so it contains no functions.
  - `Match = { fileId, priority, pluginIndex, filePath, line, content }`
  - `ScanResult = { matches: Match[] (top `limit`, sorted), lineCount: number, pluginLines: Array<[pluginIndex, count]> }`. `pluginLines` is in first-match order.

- [ ] **Step 1: Write the failing tests**

Create `tests/scan-core.test.js`:

```js
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { test } = require('node:test');

const ScanCore = require('../scripts/scan-core.js');
const { requiredRegexLiterals } = require('../scripts/reverse-search-browser.js');

// The scan as it was before scan-core: split every file into lines and test each line.
function legacySplitLines(source) {
    if (!source.length) return [];
    const lines = source.split(/\r\n|\n|\r/);
    if (/(?:\r\n|\n|\r)$/.test(source)) lines.pop();
    return lines;
}

function legacyScan(files, first, fileIds, query) {
    const { needle: raw, caseSensitive, isRegex, ranks } = query;
    const limit = query.limit ?? Infinity;
    const pattern = isRegex ? new RegExp(raw, caseSensitive ? '' : 'i') : null;
    const needle = caseSensitive ? raw : raw.toLowerCase();
    const matches = [];
    const pluginLines = new Map();
    let lineCount = 0;
    for (const fileId of fileIds || files.map((_, index) => first + index)) {
        const [pluginIndex, filePath, content] = files[fileId - first];
        const searchable = caseSensitive ? content : content.toLowerCase();
        if (!pattern && !searchable.includes(needle)) continue;
        const priority = Number(ranks[pluginIndex]) || 0;
        const lines = legacySplitLines(content);
        let fileMatches = 0;
        for (let index = 0; index < lines.length; index++) {
            const line = lines[index];
            const matched = pattern ? pattern.test(line) : (caseSensitive ? line : line.toLowerCase()).includes(needle);
            if (!matched) continue;
            fileMatches++;
            matches.push({ fileId, priority, pluginIndex, filePath, line: index + 1, content: line });
        }
        if (fileMatches) {
            lineCount += fileMatches;
            pluginLines.set(pluginIndex, (pluginLines.get(pluginIndex) || 0) + fileMatches);
        }
    }
    matches.sort((left, right) => right.priority - left.priority || left.fileId - right.fileId || left.line - right.line);
    if (matches.length > limit) matches.length = limit;
    return { matches, lineCount, pluginLines: [...pluginLines] };
}

// Runs scan-core and the legacy scan on the same input and requires identical output.
function scanBoth(files, query, first = 0, fileIds = null) {
    const full = { ranks: [], limit: Infinity, literals: query.isRegex ? requiredRegexLiterals(query.needle) : null, ...query };
    const actual = ScanCore.scanChunk(files, first, fileIds, full);
    assert.deepEqual(actual, legacyScan(files, first, fileIds, full), JSON.stringify({ files, query }));
    return actual;
}

test('literal matches report line numbers and text like the line-by-line scan', () => {
    const files = [
        [0, 'Unix.java', 'alpha\nbeta needle\n\nneedle needle\ngamma'],
        [0, 'Windows.java', 'needle\r\nbeta\r\nNEEDLE end\r\n'],
        [1, 'OldMac.java', 'one\rneedle two\r\rneedle'],
        [1, 'Mixed.java', 'a\r\nneedle\rb\nneedle\n']
    ];
    const found = scanBoth(files, { needle: 'needle', caseSensitive: false, isRegex: false });
    assert.deepEqual(found.matches.map(match => [match.filePath, match.line, match.content]), [
        ['Unix.java', 2, 'beta needle'],
        ['Unix.java', 4, 'needle needle'],
        ['Windows.java', 1, 'needle'],
        ['Windows.java', 3, 'NEEDLE end'],
        ['OldMac.java', 2, 'needle two'],
        ['OldMac.java', 4, 'needle'],
        ['Mixed.java', 2, 'needle'],
        ['Mixed.java', 4, 'needle']
    ]);
    assert.equal(found.lineCount, 8);
    assert.deepEqual(found.pluginLines, [[0, 4], [1, 4]]);
});

test('queries that span lines match nothing and an empty query matches every line', () => {
    const files = [[0, 'A.java', 'ab\ncd\r\nef\n']];
    for (const needle of ['b\nc', 'd\r', '\r\n', 'b\rc']) {
        assert.equal(scanBoth(files, { needle, caseSensitive: false, isRegex: false }).lineCount, 0);
        assert.equal(scanBoth(files, { needle, caseSensitive: true, isRegex: false }).lineCount, 0);
    }
    assert.equal(scanBoth(files, { needle: '', caseSensitive: false, isRegex: false }).lineCount, 3);
    assert.equal(scanBoth(files, { needle: '', caseSensitive: true, isRegex: false }).lineCount, 3);
});

test('case-insensitive search over non-ASCII text matches the line-by-line scan', () => {
    const files = [
        [0, 'Turkish.java', 'İstanbul\nistanbul\nİSTANBUL'],
        [0, 'Greek.java', 'ΟΔΟΣ\nοδος\nΟΔΟΣ ΟΔΟΣ'],
        [0, 'Emoji.java', '😀 needle\nNeedle 😀\n']
    ];
    for (const needle of ['istanbul', 'i̇stanbul', 'İSTANBUL', 'οδος', 'οδοσ', 'ΟΔΟΣ', 'needle', '😀 n']) {
        scanBoth(files, { needle, caseSensitive: false, isRegex: false });
        scanBoth(files, { needle, caseSensitive: true, isRegex: false });
    }
});

test('only the top `limit` matches are kept, highest priority first, but all are counted', () => {
    const files = [[0, 'Low.java', 'x\nx\nx'], [1, 'High.java', 'x\nx']];
    const found = scanBoth(files, { needle: 'x', caseSensitive: true, isRegex: false, limit: 3, ranks: [0, 5] });
    assert.deepEqual(found.matches.map(match => [match.filePath, match.line, match.priority]), [
        ['High.java', 1, 5], ['High.java', 2, 5], ['Low.java', 1, 0]
    ]);
    assert.equal(found.lineCount, 5);
    assert.deepEqual(found.pluginLines, [[0, 3], [1, 2]]);
});

test('only the requested files are scanned, with ids offset by the chunk start', () => {
    const files = [[0, 'A.java', 'hit'], [0, 'B.java', 'hit'], [1, 'C.java', 'hit']];
    const found = scanBoth(files, { needle: 'hit', caseSensitive: true, isRegex: false }, 100, [100, 102]);
    assert.deepEqual(found.matches.map(match => [match.fileId, match.filePath]), [[100, 'A.java'], [102, 'C.java']]);
});

test('regex queries match line by line like the line-by-line scan', () => {
    const files = [
        [0, 'A.java', 'onGameTick(event)\nonGameTick\nfoo'],
        [1, 'B.java', 'ongametick(x)'],
        [1, 'C.java', 'bar\r\nfoo']
    ];
    for (const needle of ['onGameTick\\(.*\\)', '^foo$', 'o|b', 'a.b', '^.{0,3}$', 'GAME']) {
        scanBoth(files, { needle, caseSensitive: true, isRegex: true });
        scanBoth(files, { needle, caseSensitive: false, isRegex: true });
    }
    assert.equal(scanBoth(files, { needle: 'onGameTick\\(', caseSensitive: true, isRegex: true }).lineCount, 1);
    assert.equal(scanBoth(files, { needle: 'onGameTick\\(', caseSensitive: false, isRegex: true }).lineCount, 2);
});

// Deterministic pseudo-random numbers (mulberry32).
function random(seed) {
    return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

test('random files and queries match the line-by-line scan exactly', () => {
    const next = random(12345);
    const pick = items => items[Math.floor(next() * items.length)];
    const asciiPieces = ['a', 'b', 'A', 'B', 'ab', ' ', '\n', '\r\n', 'needle', 'NEEDLE'];
    const allPieces = [...asciiPieces, '\r', 'İ', 'Σ', 'ß', '😀'];
    for (let round = 0; round < 1000; round++) {
        const pieces = round % 2 ? allPieces : asciiPieces;
        const text = length => Array.from({ length }, () => pick(pieces)).join('');
        const files = Array.from({ length: 1 + Math.floor(next() * 4) }, (_, index) =>
            [Math.floor(next() * 3), `F${index}.java`, text(Math.floor(next() * 40))]);
        const source = files[0][2];
        const start = Math.floor(next() * (source.length + 1));
        const needle = next() < 0.7 ? source.slice(start, start + 1 + Math.floor(next() * 6)) : text(1 + Math.floor(next() * 3));
        const ranks = [0, 1, 2].map(() => Math.floor(next() * 3));
        const limit = next() < 0.5 ? Infinity : 1 + Math.floor(next() * 5);
        for (const caseSensitive of [false, true]) scanBoth(files, { needle, caseSensitive, isRegex: false, ranks, limit });
    }
});

test('decodeChunk and scanBytes read gzip-compressed JSON chunks', async () => {
    const files = [[0, 'A.java', 'needle']];
    const bytes = new Uint8Array(zlib.gzipSync(JSON.stringify(files)));
    assert.deepEqual(await ScanCore.decodeChunk(bytes), files);
    const found = await ScanCore.scanBytes({
        bytes, first: 0, fileIds: null,
        query: { needle: 'needle', caseSensitive: true, isRegex: false, limit: Infinity, ranks: [], literals: null }
    });
    assert.equal(found.lineCount, 1);
    await assert.rejects(ScanCore.decodeChunk(new Uint8Array([1, 2, 3])));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH=$HOME/.nvm/versions/node/v20.20.2/bin:$PATH && node --test tests/scan-core.test.js`
Expected: FAIL with `Cannot find module '../scripts/scan-core.js'`.

- [ ] **Step 3: Implement scan-core**

Create `scripts/scan-core.js`:

```js
(function (root) {
    'use strict';

    // Scans decoded text chunks for one query. Shared by scan-worker.js and the
    // in-thread fallback in reverse-search-browser.js, so both give the same results.
    const textDecoder = new TextDecoder();
    const NON_ASCII = /[^\x00-\x7f]/;
    const LONE_CR = /\r(?!\n)/;

    async function gunzip(bytes) {
        if (typeof DecompressionStream !== 'function') throw new Error('This browser does not support gzip decompression');
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    async function decodeChunk(bytes) {
        return JSON.parse(textDecoder.decode(await gunzip(bytes)));
    }

    function splitLines(source) {
        if (!source.length) return [];
        const lines = source.split(/\r\n|\n|\r/);
        if (/(?:\r\n|\n|\r)$/.test(source)) lines.pop();
        return lines;
    }

    function compareMatches(left, right) {
        return right.priority - left.priority || left.fileId - right.fileId || left.line - right.line;
    }

    function keepTop(matches, limit) {
        matches.sort(compareMatches);
        if (matches.length > limit) matches.length = limit;
        return matches;
    }

    function scanLines(content, test, onLine) {
        const lines = splitLines(content);
        for (let index = 0; index < lines.length; index++) {
            if (test(lines[index])) onLine(index + 1, lines[index]);
        }
    }

    // Finds `needle` with indexOf over the whole file and works out line numbers only
    // up to each hit. `searchable` is `content` or its lowercase with every offset
    // unchanged; line breaks are '\n', optionally preceded by '\r'; `needle` is
    // non-empty and holds no line break.
    function scanLiteral(content, searchable, needle, onLine) {
        let line = 1;
        let lineStart = 0;
        let hit = searchable.indexOf(needle);
        while (hit !== -1) {
            let lineEnd = searchable.indexOf('\n', lineStart);
            while (lineEnd !== -1 && lineEnd < hit) {
                line++;
                lineStart = lineEnd + 1;
                lineEnd = searchable.indexOf('\n', lineStart);
            }
            if (lineEnd === -1) lineEnd = searchable.length;
            const textEnd = lineEnd > lineStart && searchable.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd;
            onLine(line, content.slice(lineStart, textEnd));
            if (lineEnd === searchable.length) return;
            line++;
            lineStart = lineEnd + 1;
            hit = searchable.indexOf(needle, lineStart);
        }
    }

    // files: the decoded chunk; first: id of files[0]; fileIds: ids to scan, or null
    // for every file. Keeps the top query.limit matches but counts every match.
    function scanChunk(files, first, fileIds, query) {
        const { caseSensitive, isRegex, ranks } = query;
        const limit = query.limit ?? Infinity;
        const pattern = isRegex ? new RegExp(query.needle, caseSensitive ? '' : 'i') : null;
        const needle = caseSensitive ? query.needle : query.needle.toLowerCase();
        // '' and needles spanning lines keep the per-line path, which handles them.
        const literalFast = !pattern && needle.length > 0 && !/[\r\n]/.test(needle);
        // Case-insensitive regexes use case folding, which includes() can't mirror.
        const literals = pattern && caseSensitive ? query.literals || [] : [];
        const matches = [];
        const pluginLines = new Map();
        let lineCount = 0;
        const count = fileIds ? fileIds.length : files.length;
        for (let index = 0; index < count; index++) {
            const fileId = fileIds ? fileIds[index] : first + index;
            const [pluginIndex, filePath, content] = files[fileId - first];
            const priority = Number(ranks?.[pluginIndex]) || 0;
            let fileMatches = 0;
            const onLine = (line, text) => {
                fileMatches++;
                matches.push({ fileId, priority, pluginIndex, filePath, line, content: text });
                if (matches.length >= 2 * limit + 1024) keepTop(matches, limit);
            };
            if (pattern) {
                if (literals.some(literal => !content.includes(literal))) continue;
                scanLines(content, line => pattern.test(line), onLine);
            } else {
                const searchable = caseSensitive ? content : content.toLowerCase();
                if (!searchable.includes(needle)) continue;
                // Offsets only line up when lowercasing can't change them.
                if (literalFast && (caseSensitive || !NON_ASCII.test(content)) && !LONE_CR.test(content)) {
                    scanLiteral(content, searchable, needle, onLine);
                } else {
                    scanLines(content, line => (caseSensitive ? line : line.toLowerCase()).includes(needle), onLine);
                }
            }
            if (fileMatches) {
                lineCount += fileMatches;
                pluginLines.set(pluginIndex, (pluginLines.get(pluginIndex) || 0) + fileMatches);
            }
        }
        return { matches: keepTop(matches, limit), lineCount, pluginLines: [...pluginLines] };
    }

    async function scanBytes({ bytes, first, fileIds, query }) {
        return scanChunk(await decodeChunk(bytes), first, fileIds, query);
    }

    const api = { gunzip, decodeChunk, splitLines, compareMatches, keepTop, scanChunk, scanBytes };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.ScanCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `export PATH=$HOME/.nvm/versions/node/v20.20.2/bin:$PATH && node --test tests/scan-core.test.js`
Expected: PASS, 8 tests. If a parity assertion fails, its message holds the exact files and query. Fix `scan-core.js`, never the legacy oracle.

- [ ] **Step 5: Commit**

```bash
git add scripts/scan-core.js tests/scan-core.test.js
git commit -m "Add scan-core: indexOf literal scan with per-line parity"
```

---

### Task 3: Search through scan-core in-thread

**Files:**
- Modify: `scripts/reverse-search-browser.js`
- Modify: `index.html:61`
- Test: `tests/reverse-search.test.js`

**Interfaces:**
- Consumes: `ScanCore.gunzip`, `ScanCore.scanBytes`, `ScanCore.keepTop` (Task 2).
- Produces, as private methods that later tasks extend:
  - `_scanChunk(chunk: number, fileIds: number[] | null, query: ScanQuery): Promise<ScanResult>`: scans one chunk. If the scan fails, it calls `_evict(name)` and tries once more.
  - `_scan(task): Promise<ScanResult>`: Task 5 routes this through the pool.
  - `_evict(name: string): Promise<void>`: forgets a downloaded file. Task 4 also deletes it from the persistent cache.
- Test helpers added to `tests/reverse-search.test.js`, used by Tasks 4 and 5: `BASE_URL` and `sampleIndex(t) -> indexDirectory`.

- [ ] **Step 1: Write the failing test**

In `tests/reverse-search.test.js`, add after the `listFiles` function (line 38):

```js
const BASE_URL = 'https://pages.example/index/';

// Two small plugins in one text chunk, indexed into a temporary directory removed after the test.
function sampleIndex(t) {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'reverse-index-'));
    t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
    const dataDirectory = path.join(temporaryDirectory, 'data');
    fs.mkdirSync(dataDirectory);
    fs.writeFileSync(path.join(dataDirectory, 'keris.json'), JSON.stringify({
        repository: 'https://github.com/example/keris.git',
        commit: 'abc123',
        files: [{ filePath: 'src/Keris.java', content: 'Toa Keris Cam\r\nclient.getLocalPlayer()\nKeris line\n' }]
    }));
    fs.writeFileSync(path.join(dataDirectory, 'second-plugin.json'), JSON.stringify({
        files: [{ filePath: 'src/Other.java', content: 'Toa unrelated\nclientXgetLocalPlayer\n' }]
    }));
    const indexDirectory = path.join(temporaryDirectory, 'index');
    buildIndex(dataDirectory, indexDirectory, 1);
    return indexDirectory;
}

const corruptResponse = () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
```

Add this test at the end of the file:

```js
test('a text chunk that fails to decode is fetched once more', async t => {
    const indexDirectory = sampleIndex(t);
    const realFetch = fileFetch(indexDirectory);
    let chunkFetches = 0;
    const corruptOnce = async url => {
        if (!new URL(url).pathname.includes('/chunks/')) return realFetch(url);
        return ++chunkFetches === 1 ? corruptResponse() : realFetch(url);
    };
    const searcher = new BrowserReverseSearcher(BASE_URL, corruptOnce);
    await searcher.load();
    assert.equal((await find(searcher, 'Toa Keris Cam', { caseSensitive: true })).length, 1);
    assert.equal(chunkFetches, 2);

    const alwaysCorrupt = async url => new URL(url).pathname.includes('/chunks/') ? corruptResponse() : realFetch(url);
    const broken = new BrowserReverseSearcher(BASE_URL, alwaysCorrupt);
    await broken.load();
    await assert.rejects(broken.search('Toa'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `export PATH=$HOME/.nvm/versions/node/v20.20.2/bin:$PATH && node --test tests/reverse-search.test.js`
Expected: FAIL in `a text chunk that fails to decode is fetched once more`. The first search rejects on the corrupt chunk, because nothing refetches it yet. The three existing tests pass.

- [ ] **Step 3: Wire scan-core into the searcher**

In `scripts/reverse-search-browser.js`, make these edits.

a. After `'use strict';` (line 2), insert:

```js

    const isNode = typeof module !== 'undefined' && module.exports;
    const ScanCore = isNode ? require('./scan-core.js') : root.ScanCore;
```

b. Delete these two lines (12–13):

```js
    // Decoded chunks are re-created from the compressed copies kept in memory.
    const CHUNK_CACHE_CHARS = 64 * 1024 * 1024;
```

c. Delete the `splitLines` and `gunzip` functions (lines 152–163). They now live in scan-core.

d. In `load()`, replace `await gunzip(await this._fetchBytes(` with `await ScanCore.gunzip(await this._fetchBytes(`. In `_shard()`, replace `.then(gunzip)` with `.then(ScanCore.gunzip)`.

e. In the constructor, delete these two lines:

```js
            this.chunkCache = new Map();
            this.chunkCacheChars = 0;
```

f. Delete the whole `_chunk(index) { ... }` method.

g. After the `_candidates` method, insert:

```js
        // Scans one text chunk. A chunk whose bytes fail to decode is dropped and
        // downloaded once more before the search gives up.
        async _scanChunk(chunk, fileIds, query) {
            const name = indexFileName('chunks', chunk);
            const task = { first: this.manifest.chunks[chunk], fileIds, query };
            for (let attempt = 0; ; attempt++) {
                const bytes = await this._compressed(name);
                try {
                    return await this._scan({ ...task, bytes });
                } catch (error) {
                    if (attempt > 0) throw error;
                    await this._evict(name);
                }
            }
        }

        _scan(task) {
            return ScanCore.scanBytes(task);
        }

        async _evict(name) {
            this.compressed.delete(name);
        }
```

h. Replace the whole `_search` method with:

```js
        async _search(query, options) {
            const signal = options.signal;
            const onProgress = options.onProgress || (() => {});
            const caseSensitive = options.caseSensitive === true;
            const isRegex = options.isRegex === true;
            // An invalid pattern throws here, before anything downloads.
            if (isRegex) new RegExp(query, caseSensitive ? '' : 'i');
            const literals = isRegex ? requiredRegexLiterals(query) : [query];
            const candidates = literals ? await this._candidates(literals) : null;
            signal?.throwIfAborted();

            // Group candidate files by text chunk.
            const { chunks, plugins } = this.manifest;
            const wanted = new Map();
            if (candidates) {
                let chunk = 0;
                for (const fileId of candidates) {
                    while (this.chunkEnds[chunk] <= fileId) chunk++;
                    if (!wanted.has(chunk)) wanted.set(chunk, []);
                    wanted.get(chunk).push(fileId);
                }
            } else {
                for (let chunk = 0; chunk < chunks.length; chunk++) wanted.set(chunk, null);
            }

            const limit = options.limit ?? Infinity;
            const priority = options.priority || (() => 0);
            // Plain data only: it is copied to scan workers.
            const scanQuery = {
                needle: query,
                caseSensitive,
                isRegex,
                limit,
                literals: isRegex ? literals : null,
                ranks: plugins.map(([plugin]) => Number(priority(plugin)) || 0)
            };
            const kept = [];
            let lineCount = 0;
            const pluginLines = new Map();
            const snapshot = () => {
                ScanCore.keepTop(kept, limit);
                const matched = [...pluginLines].map(([pluginIndex, lines]) => {
                    const [plugin, repository, commit] = plugins[pluginIndex];
                    return { plugin, repository, commit, lines };
                });
                const results = kept.map(({ pluginIndex, filePath, line, content }) => {
                    const [plugin, repository, commit] = plugins[pluginIndex];
                    return { plugin, repository, commit, filePath, line, content };
                });
                return { results, lineCount, plugins: matched };
            };

            let scanned = 0;
            let lastReport = 0;
            await mapConcurrent([...wanted], FETCH_CONCURRENCY, async ([chunk, fileIds]) => {
                const part = await this._scanChunk(chunk, fileIds, scanQuery);
                if (signal?.aborted) return;
                for (const match of part.matches) kept.push(match);
                if (kept.length >= 2 * limit + 1024) ScanCore.keepTop(kept, limit);
                lineCount += part.lineCount;
                for (const [pluginIndex, lines] of part.pluginLines) {
                    pluginLines.set(pluginIndex, (pluginLines.get(pluginIndex) || 0) + lines);
                }
                scanned++;
                const now = Date.now();
                if (scanned < wanted.size && now - lastReport >= PROGRESS_INTERVAL_MS) {
                    lastReport = now;
                    onProgress({ ...snapshot(), scanned, total: wanted.size });
                }
            }, () => signal?.aborted);
            signal?.throwIfAborted();
            return snapshot();
        }
```

i. In `index.html`, before `<script src="scripts/reverse-search-browser.js"></script>`, add:

```html
  <script src="scripts/scan-core.js"></script>
```

- [ ] **Step 4: Run all tests**

Run: `export PATH=$HOME/.nvm/versions/node/v20.20.2/bin:$PATH && npm test`
Expected: PASS for every JS test (the 3 existing ones, the new refetch test, and the 8 scan-core tests) and every Python test.

- [ ] **Step 5: Check parity and speed on the real index**

Run:

```bash
export PATH=$HOME/.nvm/versions/node/v20.20.2/bin:$PATH
node --expose-gc tests/bench/search-bench.js plugins/index none | tee bench-results/task3-none.txt
diff <(grep -o 'digest=[0-9a-f]*' bench-results/baseline-none.txt) <(grep -o 'digest=[0-9a-f]*' bench-results/task3-none.txt) && echo DIGESTS MATCH
```

Expected: `DIGESTS MATCH`. Warm `common literal`, `common 2-char` and `very common` are at least 2x faster than in `baseline-none.txt`, and `rare literal` and `default` are no slower. If digests differ or speed falls short, stop and report the numbers. Don't tune beyond this plan.

- [ ] **Step 6: Commit**

```bash
git add scripts/reverse-search-browser.js index.html tests/reverse-search.test.js
git commit -m "Scan text chunks with scan-core and refetch undecodable chunks"
```

---

### Task 4: Persistent index cache

**Files:**
- Create: `scripts/index-cache.js`
- Create: `tests/fake-cache-storage.js`
- Test: `tests/index-cache.test.js`
- Modify: `scripts/reverse-search-browser.js`
- Modify: `index.html`
- Test: `tests/reverse-search.test.js`

**Interfaces:**
- Consumes: `_evict(name)`, `sampleIndex(t)` and `BASE_URL` (Task 3).
- Produces:
  - `IndexCache` (`module.exports.IndexCache` under Node and `root.IndexCache` in the browser): `new IndexCache(cacheStorage, prefix = 'pluginhub-index-')`, `open(build): Promise<void>`, `get(url): Promise<Uint8Array | null>`, `put(url, bytes): Promise<void>`, `delete(url): Promise<void>`. None of these reject.
  - The constructor becomes `new BrowserReverseSearcher(indexUrl, fetchFunction, options = {})`, where `options.cacheStorage` defaults to `root.caches` and `null` disables the cache.
  - `fakeCacheStorage({ failOpen, failPut, failKeys })` and `waitFor(condition)` from `tests/fake-cache-storage.js`. The fake has `.caches: Map<name, { entries: Map<url, Uint8Array>, match, put, delete }>` and `.waitForEntries(count)`.

- [ ] **Step 1: Write the fake CacheStorage**

Create `tests/fake-cache-storage.js`:

```js
// In-memory stand-in for the browser's CacheStorage (window.caches).

// Resolves once condition() is true, checking between event-loop turns.
async function waitFor(condition, what = 'condition') {
    for (let tick = 0; tick < 20000; tick++) {
        if (condition()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error(`Timed out waiting for ${what}`);
}

function fakeCacheStorage({ failOpen = false, failPut = false, failKeys = false } = {}) {
    const caches = new Map();
    return {
        caches,
        async open(name) {
            if (failOpen) throw new DOMException('The operation is insecure.', 'SecurityError');
            if (!caches.has(name)) {
                const entries = new Map();
                caches.set(name, {
                    entries,
                    async match(url) {
                        const bytes = entries.get(String(url));
                        return bytes ? new Response(bytes) : undefined;
                    },
                    async put(url, response) {
                        if (failPut) throw new DOMException('Quota exceeded', 'QuotaExceededError');
                        entries.set(String(url), new Uint8Array(await response.arrayBuffer()));
                    },
                    async delete(url) {
                        return entries.delete(String(url));
                    }
                });
            }
            return caches.get(name);
        },
        async keys() {
            if (failKeys) throw new Error('keys failed');
            return [...caches.keys()];
        },
        async delete(name) {
            return caches.delete(name);
        },
        // Cache writes aren't awaited by the searcher; this waits for them to land.
        waitForEntries(count) {
            const stored = () => [...caches.values()].reduce((sum, cache) => sum + cache.entries.size, 0);
            return waitFor(() => stored() >= count, `${count} cache entries`);
        }
    };
}

module.exports = { fakeCacheStorage, waitFor };
```

- [ ] **Step 2: Write the failing IndexCache tests**

Create `tests/index-cache.test.js`:

```js
const assert = require('node:assert/strict');
const { test } = require('node:test');

const { IndexCache } = require('../scripts/index-cache.js');
const { fakeCacheStorage } = require('./fake-cache-storage.js');

const FILE_URL = 'https://pages.example/index/chunks/0000.bin?v=new';

test('stores and returns index files for the open build', async () => {
    const cache = new IndexCache(fakeCacheStorage());
    await cache.open('new');
    assert.equal(await cache.get(FILE_URL), null);
    await cache.put(FILE_URL, new Uint8Array([1, 2, 3]));
    assert.deepEqual(await cache.get(FILE_URL), new Uint8Array([1, 2, 3]));
    await cache.delete(FILE_URL);
    assert.equal(await cache.get(FILE_URL), null);
});

test('opening a build deletes the caches of other builds only', async () => {
    const storage = fakeCacheStorage();
    await storage.open('pluginhub-index-old');
    await storage.open('some-other-app');
    await new IndexCache(storage).open('new');
    assert.deepEqual([...storage.caches.keys()].sort(), ['pluginhub-index-new', 'some-other-app']);
});

test('an unavailable cache behaves as an empty one', async () => {
    const cache = new IndexCache(fakeCacheStorage({ failOpen: true }));
    await cache.open('new');
    await cache.put(FILE_URL, new Uint8Array([1]));
    assert.equal(await cache.get(FILE_URL), null);
    await cache.delete(FILE_URL);
});

test('a failed write or purge is ignored', async () => {
    const full = new IndexCache(fakeCacheStorage({ failPut: true }));
    await full.open('new');
    await full.put(FILE_URL, new Uint8Array([1]));
    assert.equal(await full.get(FILE_URL), null);

    const unpurgeable = new IndexCache(fakeCacheStorage({ failKeys: true }));
    await unpurgeable.open('new');
    await unpurgeable.put(FILE_URL, new Uint8Array([4]));
    assert.deepEqual(await unpurgeable.get(FILE_URL), new Uint8Array([4]));
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `export PATH=$HOME/.nvm/versions/node/v20.20.2/bin:$PATH && node --test tests/index-cache.test.js`
Expected: FAIL with `Cannot find module '../scripts/index-cache.js'`.

- [ ] **Step 4: Implement IndexCache**

Create `scripts/index-cache.js`:

```js
(function (root) {
    'use strict';

    // Keeps downloaded index files in the Cache API across visits, one cache per
    // index build. Every failure acts as a miss, so searches never depend on it.
    class IndexCache {
        constructor(cacheStorage, prefix = 'pluginhub-index-') {
            this.cacheStorage = cacheStorage;
            this.prefix = prefix;
            this.cache = null;
        }

        // Opens the cache for `build` and deletes the caches of every other build.
        async open(build) {
            const name = this.prefix + build;
            try {
                this.cache = await this.cacheStorage.open(name);
            } catch (error) {
                console.warn('Index cache unavailable:', error);
                return;
            }
            try {
                const names = await this.cacheStorage.keys();
                await Promise.all(names
                    .filter(other => other.startsWith(this.prefix) && other !== name)
                    .map(other => this.cacheStorage.delete(other)));
            } catch (error) {
                console.warn('Could not delete old index caches:', error);
            }
        }

        async get(url) {
            if (!this.cache) return null;
            try {
                const response = await this.cache.match(url);
                return response ? new Uint8Array(await response.arrayBuffer()) : null;
            } catch {
                return null;
            }
        }

        async put(url, bytes) {
            if (!this.cache) return;
            try {
                await this.cache.put(url, new Response(bytes));
            } catch {
                // Full or unavailable: the file is downloaded again next visit.
            }
        }

        async delete(url) {
            if (!this.cache) return;
            try {
                await this.cache.delete(url);
            } catch {
                // A stale entry that can't be deleted fails to decode and is refetched.
            }
        }
    }

    if (typeof module !== 'undefined' && module.exports) module.exports = { IndexCache };
    root.IndexCache = IndexCache;
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

- [ ] **Step 5: Run the IndexCache tests to verify they pass**

Run: `export PATH=$HOME/.nvm/versions/node/v20.20.2/bin:$PATH && node --test tests/index-cache.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 6: Write the failing searcher cache tests**

In `tests/reverse-search.test.js`, add below the existing `require` of `reverse-search-browser.js` (line 8):

```js
const ScanCore = require('../scripts/scan-core.js');
const { fakeCacheStorage, waitFor } = require('./fake-cache-storage.js');
```

Add these tests at the end of the file:

```js
test('a return visit loads every index file from the persistent cache', async t => {
    const indexDirectory = sampleIndex(t);
    const storage = fakeCacheStorage();
    const first = new BrowserReverseSearcher(BASE_URL, fileFetch(indexDirectory), { cacheStorage: storage });
    await first.load();
    await first.prefetch();
    await storage.waitForEntries(first.manifest.shardCount + first.manifest.chunks.length);

    const requests = [];
    const second = new BrowserReverseSearcher(BASE_URL, fileFetch(indexDirectory, requests), { cacheStorage: storage });
    await second.load();
    assert.equal((await find(second, 'Toa Keris Cam', { caseSensitive: true })).length, 1);
    await second.prefetch();
    assert.deepEqual(requests, ['manifest.bin']);
});

test('a new index build replaces the cached files of the old one', async t => {
    const indexDirectory = sampleIndex(t);
    const storage = fakeCacheStorage();
    (await storage.open('pluginhub-index-oldbuild')).entries.set(`${BASE_URL}chunks/0000.bin?v=oldbuild`, new Uint8Array([9]));
    const searcher = new BrowserReverseSearcher(BASE_URL, fileFetch(indexDirectory), { cacheStorage: storage });
    await searcher.load();
    assert.deepEqual([...storage.caches.keys()], [`pluginhub-index-${searcher.manifest.build}`]);
});

test('a corrupt cached file is replaced from the network', async t => {
    const indexDirectory = sampleIndex(t);
    const storage = fakeCacheStorage();
    const requests = [];
    const searcher = new BrowserReverseSearcher(BASE_URL, fileFetch(indexDirectory, requests), { cacheStorage: storage });
    await searcher.load();
    const chunkUrl = `${BASE_URL}chunks/0000.bin?v=${searcher.manifest.build}`;
    const cache = await storage.open(`pluginhub-index-${searcher.manifest.build}`);
    cache.entries.set(chunkUrl, new Uint8Array([1, 2, 3]));

    assert.equal((await find(searcher, 'Toa Keris Cam', { caseSensitive: true })).length, 1);
    assert.deepEqual(requests.filter(name => name.startsWith('chunks/')), ['chunks/0000.bin']);
    await waitFor(() => cache.entries.get(chunkUrl)?.length > 3, 'the replaced chunk');
    assert.ok(Array.isArray(await ScanCore.decodeChunk(cache.entries.get(chunkUrl))));
});

test('searches work when the persistent cache is unavailable or full', async t => {
    const indexDirectory = sampleIndex(t);
    for (const storage of [fakeCacheStorage({ failOpen: true }), fakeCacheStorage({ failPut: true })]) {
        const searcher = new BrowserReverseSearcher(BASE_URL, fileFetch(indexDirectory), { cacheStorage: storage });
        await searcher.load();
        assert.equal((await find(searcher, 'Toa Keris Cam', { caseSensitive: true })).length, 1);
    }
});
```

- [ ] **Step 7: Run the tests to verify they fail**

Run: `export PATH=$HOME/.nvm/versions/node/v20.20.2/bin:$PATH && node --test tests/reverse-search.test.js`
Expected: FAIL in `a return visit loads every index file from the persistent cache` (a timeout waiting for cache entries, because nothing writes them yet), `a new index build replaces…` and `a corrupt cached file…`. The unavailable-or-full test may already pass.

- [ ] **Step 8: Wire the cache into the searcher**

In `scripts/reverse-search-browser.js`, make these edits.

a. Below the `ScanCore` import line, add:

```js
    const { IndexCache } = isNode ? require('./index-cache.js') : root;
```

b. Change the constructor signature and add the cache. Replace:

```js
        constructor(indexUrl, fetchFunction = root.fetch.bind(root)) {
```

with:

```js
        // options.cacheStorage: CacheStorage for the persistent cache (default: the
        // browser's `caches`; null turns it off).
        constructor(indexUrl, fetchFunction = root.fetch.bind(root), options = {}) {
```

and add as the constructor's last statement:

```js
            const cacheStorage = 'cacheStorage' in options ? options.cacheStorage : root.caches;
            this.cache = cacheStorage ? new IndexCache(cacheStorage) : null;
```

c. In `load()`, after `this.manifest = manifest;`, add:

```js
            if (this.cache) await this.cache.open(manifest.build);
```

d. Replace the `_compressed` method and the comment above it with:

```js
        _fileUrl(name) {
            return new URL(`${name}?v=${this.manifest.build}`, this.baseUrl).href;
        }

        // Compressed index files are kept for the whole session (~95 MB when
        // fully prefetched), so repeat lookups never touch the network.
        _compressed(name) {
            if (!this.compressed.has(name)) {
                const promise = this._download(name);
                promise.then(() => {
                    this.loadedFiles.add(name);
                    this.prefetchStatus?.report();
                }, () => this.compressed.delete(name));
                this.compressed.set(name, promise);
            }
            return this.compressed.get(name);
        }

        // An index file from the persistent cache, else from the network (then cached).
        async _download(name) {
            const url = this._fileUrl(name);
            const cached = this.cache ? await this.cache.get(url) : null;
            if (cached) return cached;
            const bytes = await this._fetchBytes(url);
            if (this.cache) this.cache.put(url, bytes);
            return bytes;
        }
```

e. Replace `_evict` with:

```js
        async _evict(name) {
            this.compressed.delete(name);
            if (this.cache) await this.cache.delete(this._fileUrl(name));
        }
```

f. In `index.html`, after the `scan-core.js` script tag, add:

```html
  <script src="scripts/index-cache.js"></script>
```

- [ ] **Step 9: Run all tests**

Run: `export PATH=$HOME/.nvm/versions/node/v20.20.2/bin:$PATH && npm test`
Expected: PASS for all JS tests (including the 4 new searcher tests and the 4 IndexCache tests) and the Python tests.

- [ ] **Step 10: Commit**

```bash
git add scripts/index-cache.js scripts/reverse-search-browser.js index.html tests/fake-cache-storage.js tests/index-cache.test.js tests/reverse-search.test.js
git commit -m "Keep downloaded index files in the Cache API across visits"
```

---

### Task 5: Scan worker pool

**Files:**
- Create: `scripts/scan-pool.js`
- Create: `scripts/scan-worker.js`
- Create: `tests/fake-workers.js`
- Test: `tests/scan-pool.test.js`
- Modify: `scripts/reverse-search-browser.js`
- Modify: `index.html`
- Test: `tests/reverse-search.test.js`
- Create: `tests/bench/node-scan-worker.js`
- Modify: `tests/bench/search-bench.js`

**Interfaces:**
- Consumes: `ScanCore.scanBytes(task)` (Task 2), and `_scan(task)`, `sampleIndex` and `BASE_URL` (Task 3).
- Produces:
  - `ScanPool` (`module.exports.ScanPool` under Node and `root.ScanPool` in the browser): `new ScanPool(createWorker: () => WorkerLike, size: number, fallback: (task) => Promise<result>)`, `scan(task): Promise<result>`, and `size` (live workers).
  - `WorkerLike = { postMessage(message), onmessage, onerror, terminate() }`, as a Web Worker provides.
  - Message protocol: main posts `{ id, task }`. The worker replies `{ id, result }` or `{ id, error: string }`.
  - Searcher options gain `createWorker` (null scans in-thread) and `poolSize`.
  - `fakeWorker({ handle, crash, loadError })` from `tests/fake-workers.js`.
  - Bench: the `BENCH_WORKERS=<n>` environment variable scans on n worker threads.

- [ ] **Step 1: Write the fake worker**

Create `tests/fake-workers.js`:

```js
const ScanCore = require('../scripts/scan-core.js');

// Stand-in for a Web Worker running scripts/scan-worker.js. Messages are copied
// with structuredClone, as postMessage would, and answered asynchronously by
// handle(task). `crash` fires onerror instead of answering; `loadError` fires
// onerror as soon as the worker is created, like a missing worker script.
function fakeWorker({ handle = ScanCore.scanBytes, crash = false, loadError = false } = {}) {
    const worker = {
        onmessage: null,
        onerror: null,
        posted: [],
        terminated: false,
        postMessage(message) {
            const copy = structuredClone(message);
            worker.posted.push(copy);
            setImmediate(async () => {
                if (worker.terminated) return;
                if (crash) {
                    worker.onerror?.({ message: 'worker crashed' });
                    return;
                }
                let reply;
                try {
                    reply = { id: copy.id, result: structuredClone(await handle(copy.task)) };
                } catch (error) {
                    reply = { id: copy.id, error: error.message };
                }
                if (!worker.terminated) worker.onmessage?.({ data: reply });
            });
        },
        terminate() {
            worker.terminated = true;
        }
    };
    if (loadError) setImmediate(() => worker.onerror?.({ message: 'scan-worker.js: HTTP 404' }));
    return worker;
}

module.exports = { fakeWorker };
```

- [ ] **Step 2: Write the failing pool tests**

Create `tests/scan-pool.test.js`:

```js
const assert = require('node:assert/strict');
const { test } = require('node:test');

const { ScanPool } = require('../scripts/scan-pool.js');
const { fakeWorker } = require('./fake-workers.js');

const double = async task => task.n * 2;
const unusedFallback = async () => { throw new Error('fallback should not run'); };

test('tasks run on the workers, at most one per worker at a time', async () => {
    const workers = [];
    let running = 0;
    let peak = 0;
    const handle = async task => {
        running++;
        peak = Math.max(peak, running);
        await new Promise(resolve => setImmediate(resolve));
        running--;
        return task.n * 2;
    };
    const pool = new ScanPool(() => {
        const worker = fakeWorker({ handle });
        workers.push(worker);
        return worker;
    }, 2, unusedFallback);
    assert.deepEqual(await Promise.all([1, 2, 3, 4, 5].map(n => pool.scan({ n }))), [2, 4, 6, 8, 10]);
    assert.equal(peak, 2);
    assert.ok(workers.every(worker => worker.posted.length > 0));
});

test('a task the worker reports as failed is retried once in-thread', async () => {
    const worker = fakeWorker({ handle: async () => { throw new Error('bad gzip'); } });
    const fallbackTasks = [];
    const pool = new ScanPool(() => worker, 1, async task => {
        fallbackTasks.push(task);
        return 'fallback';
    });
    assert.equal(await pool.scan({ n: 1 }), 'fallback');
    assert.deepEqual(fallbackTasks, [{ n: 1 }]);
    assert.equal(pool.size, 1);
    assert.equal(worker.terminated, false);
});

test('a crashed worker is dropped and its task runs in-thread', async () => {
    const crashing = fakeWorker({ crash: true });
    const healthy = fakeWorker({ handle: double });
    const created = [crashing, healthy];
    const pool = new ScanPool(() => created.shift(), 2, async task => `fallback ${task.n}`);
    const results = await Promise.all([1, 2, 3].map(n => pool.scan({ n })));
    assert.equal(results.filter(result => String(result).startsWith('fallback')).length, 1);
    assert.equal(crashing.terminated, true);
    assert.equal(pool.size, 1);
    assert.equal(await pool.scan({ n: 4 }), 8);
});

test('when no worker loads, every task runs in-thread', async () => {
    const pool = new ScanPool(() => fakeWorker({ loadError: true }), 2, async task => task.n * 10);
    assert.deepEqual(await Promise.all([1, 2, 3].map(n => pool.scan({ n }))), [10, 20, 30]);
    assert.equal(pool.size, 0);
    assert.equal(await pool.scan({ n: 4 }), 40);
});

test('a worker that cannot be created is skipped', async () => {
    const pool = new ScanPool(() => { throw new Error('Worker is not defined'); }, 2, async task => task.n);
    assert.equal(pool.size, 0);
    assert.equal(await pool.scan({ n: 7 }), 7);
});

test('a task fails when its in-thread retry also fails', async () => {
    const pool = new ScanPool(() => fakeWorker({ crash: true }), 1, async () => { throw new Error('corrupt chunk'); });
    await assert.rejects(pool.scan({ n: 1 }), /corrupt chunk/);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `export PATH=$HOME/.nvm/versions/node/v20.20.2/bin:$PATH && node --test tests/scan-pool.test.js`
Expected: FAIL with `Cannot find module '../scripts/scan-pool.js'`.

- [ ] **Step 4: Implement the pool and the worker**

Create `scripts/scan-pool.js`:

```js
(function (root) {
    'use strict';

    // Runs scan tasks on a pool of workers, one task per worker at a time. A task
    // whose worker fails is retried once with `fallback` (the in-thread scan); a
    // worker that errors is dropped, and once none are left every task runs on
    // `fallback`.
    class ScanPool {
        constructor(createWorker, size, fallback) {
            this.fallback = fallback;
            this.workers = new Set();
            this.idle = [];
            this.queue = [];
            // Running job by worker.
            this.running = new Map();
            this.nextId = 1;
            for (let index = 0; index < size; index++) {
                let worker;
                try {
                    worker = createWorker();
                } catch (error) {
                    console.warn('Scan worker unavailable:', error);
                    continue;
                }
                worker.onmessage = event => this._finished(worker, event.data);
                worker.onerror = event => this._failed(worker, event);
                this.workers.add(worker);
                this.idle.push(worker);
            }
        }

        get size() {
            return this.workers.size;
        }

        scan(task) {
            if (!this.workers.size) return this.fallback(task);
            return new Promise((resolve, reject) => {
                this.queue.push({ id: this.nextId++, task, resolve, reject });
                this._dispatch();
            });
        }

        _dispatch() {
            while (this.idle.length && this.queue.length) {
                const worker = this.idle.pop();
                const job = this.queue.shift();
                this.running.set(worker, job);
                worker.postMessage({ id: job.id, task: job.task });
            }
        }

        _finished(worker, { id, result, error }) {
            const job = this.running.get(worker);
            if (!job || job.id !== id) return;
            this.running.delete(worker);
            this.idle.push(worker);
            if (error === undefined) job.resolve(result);
            else this._runInThread(job);
            this._dispatch();
        }

        // The worker crashed or its script never loaded.
        _failed(worker, event) {
            event?.preventDefault?.();
            console.warn('Scan worker failed:', event?.message || event);
            const job = this.running.get(worker);
            this.running.delete(worker);
            this.workers.delete(worker);
            this.idle = this.idle.filter(other => other !== worker);
            worker.terminate();
            if (job) this._runInThread(job);
            if (this.workers.size) this._dispatch();
            else for (const queued of this.queue.splice(0)) this._runInThread(queued);
        }

        _runInThread(job) {
            Promise.resolve().then(() => this.fallback(job.task)).then(job.resolve, job.reject);
        }
    }

    if (typeof module !== 'undefined' && module.exports) module.exports = { ScanPool };
    root.ScanPool = ScanPool;
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

Create `scripts/scan-worker.js`:

```js
// Scans text chunks off the main thread for ScanPool (scan-pool.js).
importScripts('scan-core.js');

self.onmessage = async event => {
    const { id, task } = event.data;
    try {
        self.postMessage({ id, result: await self.ScanCore.scanBytes(task) });
    } catch (error) {
        self.postMessage({ id, error: String((error && error.message) || error) });
    }
};
```

- [ ] **Step 5: Run the pool tests to verify they pass**

Run: `export PATH=$HOME/.nvm/versions/node/v20.20.2/bin:$PATH && node --test tests/scan-pool.test.js`
Expected: PASS, 6 tests. The `console.warn` output from the crash tests is expected.

- [ ] **Step 6: Write the failing searcher worker tests**

In `tests/reverse-search.test.js`, add below the `fake-cache-storage` require:

```js
const { fakeWorker } = require('./fake-workers.js');

// Plugin order in `plugins` follows chunk completion, which workers may reorder.
const normalize = found => ({ ...found, plugins: [...found.plugins].sort((left, right) => left.plugin.localeCompare(right.plugin)) });
```

Add these tests at the end of the file:

```js
test('searches on scan workers return exactly what the in-thread scan returns', async t => {
    const indexDirectory = sampleIndex(t);
    const plain = new BrowserReverseSearcher(BASE_URL, fileFetch(indexDirectory));
    const pooledWorkers = [];
    const pooled = new BrowserReverseSearcher(BASE_URL, fileFetch(indexDirectory), {
        createWorker: () => {
            const worker = fakeWorker();
            pooledWorkers.push(worker);
            return worker;
        },
        poolSize: 2
    });
    const crashing = new BrowserReverseSearcher(BASE_URL, fileFetch(indexDirectory), { createWorker: () => fakeWorker({ crash: true }), poolSize: 2 });
    await Promise.all([plain, pooled, crashing].map(searcher => searcher.load()));
    const ranked = { limit: 1, priority: plugin => plugin === 'second-plugin' ? 10 : 0 };
    for (const [query, options] of [
        ['Toa', {}],
        ['Toa Keris Cam', { caseSensitive: true }],
        ['client.getLocalPlayer', { isRegex: true }],
        ['zz', {}],
        ['^.{0,2}$', { isRegex: true }],
        ['Toa', ranked]
    ]) {
        const expected = normalize(await plain.search(query, options));
        assert.deepEqual(normalize(await pooled.search(query, options)), expected);
        assert.deepEqual(normalize(await crashing.search(query, options)), expected);
    }
    // The pooled searcher really scanned on its workers.
    assert.equal(pooledWorkers.length, 2);
    assert.ok(pooledWorkers.some(worker => worker.posted.length > 0));
});

test('an aborted search never leaks results into the next one', async t => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'reverse-index-'));
    t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
    // Each file is bigger than one text chunk, so the search spans three chunks.
    const dataDirectory = path.join(temporaryDirectory, 'data');
    fs.mkdirSync(dataDirectory);
    for (const name of ['first', 'second', 'third']) {
        fs.writeFileSync(path.join(dataDirectory, `${name}.json`), JSON.stringify({
            files: [{ filePath: 'src/Big.java', content: `needle\n${'x'.repeat(600 * 1024)}\n` }]
        }));
    }
    const indexDirectory = path.join(temporaryDirectory, 'index');
    buildIndex(dataDirectory, indexDirectory, 1);

    const searcher = new BrowserReverseSearcher(BASE_URL, fileFetch(indexDirectory), { createWorker: () => fakeWorker(), poolSize: 2 });
    await searcher.load();
    const controller = new AbortController();
    let next = null;
    const aborted = searcher.search('needle', {
        signal: controller.signal,
        // Abort after the first chunk, while the others are still on workers.
        onProgress: () => {
            if (next) return;
            controller.abort();
            next = searcher.search('needle', { caseSensitive: true });
        }
    });
    await assert.rejects(aborted, { name: 'AbortError' });
    assert.ok(next, 'the first search reported progress before finishing');
    const found = await next;
    assert.equal(found.lineCount, 3);
    assert.equal(found.results.length, 3);
});
```

- [ ] **Step 7: Run the tests to verify they fail**

Run: `export PATH=$HOME/.nvm/versions/node/v20.20.2/bin:$PATH && node --test tests/reverse-search.test.js`
Expected: FAIL in `searches on scan workers return exactly…` at `assert.equal(pooledWorkers.length, 2)` (actual 0), because the searcher ignores `createWorker` until the pool is wired in. The abort test may already pass with the in-thread scan. It is a guard that must keep passing once workers run.

- [ ] **Step 8: Wire the pool into the searcher**

In `scripts/reverse-search-browser.js`, make these edits.

a. Below the `IndexCache` import line, add:

```js
    const { ScanPool } = isNode ? require('./scan-pool.js') : root;
    // Captured while this script runs; the scan worker is loaded from beside it.
    const SCRIPT_URL = typeof document !== 'undefined' && document.currentScript ? document.currentScript.src : null;
    const MAX_SCAN_WORKERS = 4;

    function defaultCreateWorker() {
        if (!SCRIPT_URL || typeof root.Worker !== 'function' || typeof root.DecompressionStream !== 'function') return null;
        return () => new root.Worker(new URL('scan-worker.js', SCRIPT_URL));
    }
```

b. Extend the constructor comment and add the pool after the cache lines:

```js
        // options.cacheStorage: CacheStorage for the persistent cache (default: the
        // browser's `caches`; null turns it off). options.createWorker: () => a
        // Worker running scan-worker.js (default: a real Worker where supported;
        // null scans in-thread). options.poolSize: how many workers.
```

```js
            const createWorker = 'createWorker' in options ? options.createWorker : defaultCreateWorker();
            const poolSize = options.poolSize ??
                Math.max(1, Math.min(MAX_SCAN_WORKERS, (root.navigator?.hardwareConcurrency || 2) - 1));
            this.pool = createWorker ? new ScanPool(createWorker, poolSize, ScanCore.scanBytes) : null;
```

c. Replace `_scan` with:

```js
        _scan(task) {
            return this.pool ? this.pool.scan(task) : ScanCore.scanBytes(task);
        }
```

d. In `index.html`, after the `index-cache.js` script tag, add:

```html
  <script src="scripts/scan-pool.js"></script>
```

- [ ] **Step 9: Run all tests**

Run: `export PATH=$HOME/.nvm/versions/node/v20.20.2/bin:$PATH && npm test`
Expected: PASS for all JS tests and the Python tests.

- [ ] **Step 10: Let the benchmark scan on worker threads**

Create `tests/bench/node-scan-worker.js`:

```js
// worker_threads stand-in for scripts/scan-worker.js, used by search-bench.js.
const { parentPort } = require('node:worker_threads');
const ScanCore = require('../../scripts/scan-core.js');

parentPort.on('message', async ({ id, task }) => {
    try {
        parentPort.postMessage({ id, result: await ScanCore.scanBytes(task) });
    } catch (error) {
        parentPort.postMessage({ id, error: String((error && error.message) || error) });
    }
});
```

In `tests/bench/search-bench.js`, insert this line directly below the existing usage comment line (`// node --expose-gc tests/bench/search-bench.js …`):

```js
// BENCH_WORKERS=<n> scans on n worker threads (the current searcher only).
```

add above the `(async () => {` line:

```js
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
```

and replace the loop body inside `(async () => { ... })` with:

```js
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
```

(This replaces the earlier `console.log` and `for` loop, and keeps `process.exit(0)`.)

- [ ] **Step 11: Check parity and speed with workers**

Run:

```bash
export PATH=$HOME/.nvm/versions/node/v20.20.2/bin:$PATH
BENCH_WORKERS=3 node --expose-gc tests/bench/search-bench.js plugins/index none | tee bench-results/task5-none-w3.txt
diff <(grep -o 'digest=[0-9a-f]*' bench-results/baseline-none.txt) <(grep -o 'digest=[0-9a-f]*' bench-results/task5-none-w3.txt) && echo DIGESTS MATCH
```

Expected: `DIGESTS MATCH`. Warm common queries are faster than `bench-results/task3-none.txt`. Note the `regex no literal` time: each worker returns up to `limit` lines per chunk, so copying results back can cost time there. Report it as measured.

- [ ] **Step 12: Commit**

```bash
git add scripts/scan-pool.js scripts/scan-worker.js scripts/reverse-search-browser.js index.html tests/fake-workers.js tests/scan-pool.test.js tests/reverse-search.test.js tests/bench/node-scan-worker.js tests/bench/search-bench.js
git commit -m "Scan text chunks on a pool of Web Workers"
```

---

### Task 6: Verify against the success criteria

**Files:** none changed, unless a check fails. A failure is reported to the human, not patched outside this plan.

**Interfaces:**
- Consumes: everything above.
- Produces: a short report covering each success criterion from the spec, with numbers.

- [ ] **Step 1: Full test suite**

Run: `export PATH=$HOME/.nvm/versions/node/v20.20.2/bin:$PATH && npm test`
Expected: all JS and Python tests PASS.

- [ ] **Step 2: Benchmark against the baseline**

Run:

```bash
export PATH=$HOME/.nvm/versions/node/v20.20.2/bin:$PATH
node --expose-gc tests/bench/search-bench.js plugins/index none | tee bench-results/final-none-w0.txt
BENCH_WORKERS=3 node --expose-gc tests/bench/search-bench.js plugins/index none | tee bench-results/final-none-w3.txt
BENCH_WORKERS=3 node --expose-gc tests/bench/search-bench.js plugins/index fast | tee bench-results/final-fast-w3.txt
for run in final-none-w0 final-none-w3; do diff <(grep -o 'digest=[0-9a-f]*' bench-results/baseline-none.txt) <(grep -o 'digest=[0-9a-f]*' bench-results/$run.txt) && echo "$run DIGESTS MATCH"; done
diff <(grep -o 'digest=[0-9a-f]*' bench-results/baseline-fast.txt) <(grep -o 'digest=[0-9a-f]*' bench-results/final-fast-w3.txt) && echo "final-fast-w3 DIGESTS MATCH"
```

Check each criterion against the baseline files and record pass or fail with the numbers:
- Every digest matches.
- `rare literal` and `default`, cold and warm, are no slower than baseline.
- Warm common queries (`common literal`, `common 2-char`, `very common`) are at least 2x faster in `final-none-w0` (the scan change alone). Record the gain from workers in `final-none-w3` as measured.
- `peakMB` on the common queries is below baseline.

- [ ] **Step 3: Real-browser check**

Serve the repository root (the page loads `plugins/index/` relative to itself):

```bash
python3 -m http.server 8000
```

In Chrome at `http://localhost:8000/` (localhost counts as a secure context, so the Cache API works):
1. DevTools → Sources → Threads lists 3 or 4 `scan-worker.js` threads (fewer on machines with fewer cores).
2. Uncheck Regex and Case sensitive, then search `client`. The status shows "Done in …s", and typing into the second search box stays responsive while it runs.
3. After "✓ Index loaded", DevTools → Application → Cache storage shows `pluginhub-index-<build>` with about 1,640 entries.
4. Reload. In DevTools → Network, filtered by `.bin`, the only request is `manifest.bin`, and a search still returns results.
5. DevTools → Network request blocking: block `scan-worker.js` and reload. Searches still work, and the console shows `Scan worker failed`.
6. Device toolbar (a phone profile) with CPU throttling at 4x: a `client` search completes and the page stays usable.

In Firefox, repeat steps 2 and 4, then open a private window and confirm search works there (the console may show `Index cache unavailable`).

- [ ] **Step 4: Report**

Write the criteria results from Steps 2 and 3 back to the human in chat. Include the before and after numbers for the common queries and any criterion that failed.
