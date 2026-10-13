const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { BrowserReverseSearcher, requiredRegexLiterals } = require('../scripts/reverse-search-browser.js');
const ScanCore = require('../scripts/scan-core.js');
const { fakeCacheStorage, waitFor } = require('./fake-cache-storage.js');
const { fakeWorker } = require('./fake-workers.js');

// Plugin order in `plugins` follows chunk completion, which workers may reorder.
const normalize = found => ({ ...found, plugins: [...found.plugins].sort((left, right) => left.plugin.localeCompare(right.plugin)) });

const python = process.env.PYTHON || 'python3';

function buildIndex(dataDirectory, indexDirectory, workers) {
    execFileSync(python, [
        path.join(__dirname, '..', 'builders', 'build_reverse_index.py'),
        dataDirectory,
        indexDirectory,
        String(workers)
    ], { stdio: 'pipe' });
}

function fileFetch(indexDirectory, log = []) {
    return async url => {
        const relative = new URL(url).pathname.replace(/^\/index\//, '');
        log.push(relative);
        const filePath = path.join(indexDirectory, relative);
        if (!fs.existsSync(filePath)) return { ok: false, status: 404 };
        const bytes = fs.readFileSync(filePath);
        return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    };
}

const find = (searcher, ...args) => searcher.search(...args).then(found => found.results);

function listFiles(directory) {
    return fs.readdirSync(directory, { recursive: true }).sort()
        .filter(name => fs.statSync(path.join(directory, name)).isFile())
        .map(name => [name, fs.readFileSync(path.join(directory, name))]);
}

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

test('reverse index searches source lines and preserves exact result metadata', async t => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'reverse-index-'));
    t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

    const dataDirectory = path.join(temporaryDirectory, 'data');
    fs.mkdirSync(dataDirectory);
    fs.writeFileSync(path.join(dataDirectory, 'zom-keris-cam.json'), JSON.stringify({
        internalName: 'wrong-plugin',
        repository: 'https://github.com/example/zom-keris-cam.git',
        commit: 'abc123',
        description: 'metadata-only-needle',
        files: [{
            pluginName: 'also-wrong',
            filePath: 'src/main/java/com/zom/TOAKerisCamPlugin.java',
            content: [
                'package com.zom;',
                '',
                '\tname = "Toa Keris Cam"',
                'RunePouchPlacement enum',
                'Visible phrase appears here',
                'Toa happens on another line',
                'Keris appears on this different line',
                'client.getLocalPlayer().getName()'
            ].join('\r\n')
        }]
    }));
    fs.writeFileSync(path.join(dataDirectory, 'second-plugin.json'), JSON.stringify({
        files: [{ filePath: 'src/Other.java', content: 'Toa unrelated\nclientXgetLocalPlayer\n' }]
    }));

    const indexDirectory = path.join(temporaryDirectory, 'index');
    buildIndex(dataDirectory, indexDirectory, 2);
    const serialDirectory = path.join(temporaryDirectory, 'serial');
    buildIndex(dataDirectory, serialDirectory, 1);
    assert.deepEqual(listFiles(indexDirectory), listFiles(serialDirectory));

    const requests = [];
    const searcher = new BrowserReverseSearcher('https://pages.example/index/', fileFetch(indexDirectory, requests));
    await searcher.load();

    const phrase = await find(searcher, 'Toa Keris Cam', { caseSensitive: true });
    assert.deepEqual(phrase, [{
        plugin: 'zom-keris-cam',
        repository: 'https://github.com/example/zom-keris-cam.git',
        commit: 'abc123',
        filePath: 'src/main/java/com/zom/TOAKerisCamPlugin.java',
        line: 3,
        content: '\tname = "Toa Keris Cam"'
    }]);

    assert.equal((await find(searcher, 'PouchPlacement')).length, 1);
    assert.equal((await find(searcher, 'visible phrase')).length, 1);
    assert.equal((await find(searcher, 'VISIBLE PHRASE', { caseSensitive: true })).length, 0);
    assert.equal((await find(searcher, 'metadata-only-needle')).length, 0);
    assert.equal((await find(searcher, 'Toa Keris')).length, 1);
    assert.equal((await find(searcher, 'Keris Toa')).length, 0);
    assert.equal((await find(searcher, 'Toa')).length, 3);

    // Regex queries use the index through their required literals.
    requests.length = 0;
    const regex = await find(searcher, 'client.getLocalPlayer', { isRegex: true, caseSensitive: true });
    assert.deepEqual(regex.map(result => result.plugin), ['second-plugin', 'zom-keris-cam']);
    assert.ok(requests.every(name => !name.startsWith('manifest')));
    assert.equal((await find(searcher, 'client\\.getLocal', { isRegex: true })).length, 1);
    assert.equal((await find(searcher, '^Toa (happens|unrelated)', { isRegex: true, caseSensitive: true })).length, 2);

    // Queries with no usable trigram fall back to scanning every chunk.
    assert.equal((await find(searcher, '^.{0,2}$', { isRegex: true })).length, 1);
    assert.equal((await find(searcher, 'zz')).length, 0);

    // Dropped connections and server errors are retried; missing files are not.
    const realFetch = fileFetch(indexDirectory);
    const attempts = new Map();
    const flakyFetch = async url => {
        const count = (attempts.get(url) || 0) + 1;
        attempts.set(url, count);
        if (count === 1) throw new TypeError('Failed to fetch');
        if (count === 2) return { ok: false, status: 503 };
        return realFetch(url);
    };
    const flakySearcher = new BrowserReverseSearcher('https://pages.example/index/', flakyFetch);
    await flakySearcher.load();
    assert.deepEqual(await find(flakySearcher, 'Toa Keris Cam', { caseSensitive: true }), phrase);
    const missing = new BrowserReverseSearcher('https://pages.example/missing/', async () => ({ ok: false, status: 404 }));
    await assert.rejects(missing.load(), /HTTP 404/);

    // Aborted searches reject.
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(find(searcher, 'Toa', { signal: controller.signal }), { name: 'AbortError' });

    // Every match is counted, but only `limit` lines are kept, highest priority first.
    const limited = await searcher.search('Toa', { limit: 1, priority: plugin => plugin === 'second-plugin' ? 10 : 0 });
    assert.equal(limited.lineCount, 3);
    assert.deepEqual(limited.results.map(result => result.content), ['Toa unrelated']);
    assert.deepEqual(limited.plugins.map(({ plugin, lines }) => [plugin, lines]).sort(), [['second-plugin', 1], ['zom-keris-cam', 2]]);

    // After prefetching, searches need no network at all.
    const prefetchRequests = [];
    const prefetcher = new BrowserReverseSearcher('https://pages.example/index/', fileFetch(indexDirectory, prefetchRequests));
    await prefetcher.load();
    const reports = [];
    await prefetcher.prefetch((done, total) => reports.push([done, total]));
    const total = reports[0][1];
    assert.deepEqual(reports[0], [0, total]);
    assert.deepEqual(reports.at(-1), [total, total]);
    prefetchRequests.length = 0;
    assert.deepEqual(await find(prefetcher, 'Toa Keris Cam', { caseSensitive: true }), phrase);
    assert.equal((await find(prefetcher, '^.{0,2}$', { isRegex: true })).length, 1);
    assert.deepEqual(prefetchRequests, []);
});

test('searches report partial results and pause the index download', async t => {
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

    const searcher = new BrowserReverseSearcher('https://pages.example/index/', fileFetch(indexDirectory));
    await searcher.load();
    const partials = [];
    const found = await searcher.search('needle', { onProgress: partial => partials.push(partial) });
    assert.equal(found.lineCount, 3);
    assert.ok(partials.length >= 1);
    for (const partial of partials) {
        assert.equal(partial.total, 3);
        assert.ok(partial.scanned < partial.total);
        assert.equal(partial.lineCount, partial.scanned);
        assert.equal(partial.results.length, partial.scanned);
    }

    // The download reports itself paused while a search runs, then resumed,
    // and counts the files earlier searches already fetched.
    const reports = [];
    const running = searcher.search('needle');
    const prefetching = searcher.prefetch((done, total, failed, paused) => reports.push({ done, total, paused }));
    assert.equal(reports.length, 1);
    assert.equal(reports[0].paused, true);
    assert.equal(reports[0].done, searcher.loadedFiles.size);
    assert.ok(reports[0].done > 3);
    await running;
    assert.equal(reports.at(-1).paused, false);
    await prefetching;
    assert.deepEqual(reports.at(-1), { done: reports[0].total, total: reports[0].total, paused: false });
    assert.ok(reports.every((report, index) => !index || report.done >= reports[index - 1].done));
});

test('required regex literals are conservative', () => {
    assert.deepEqual(requiredRegexLiterals('client.getLocalPlayer'), ['client', 'getLocalPlayer']);
    assert.deepEqual(requiredRegexLiterals('ItemID\\.ABYSSAL_WHIP'), ['ItemID.ABYSSAL_WHIP']);
    assert.deepEqual(requiredRegexLiterals('colou?r'), ['colo']);
    assert.deepEqual(requiredRegexLiterals('abcd*e'), ['abc']);
    assert.deepEqual(requiredRegexLiterals('(a|b)getItem[A-Z]+Container'), ['getItem', 'Container']);
    assert.deepEqual(requiredRegexLiterals('\\x41bcdef'), ['bcdef']);
    assert.deepEqual(requiredRegexLiterals('[]abc]def'), ['def']);
    assert.equal(requiredRegexLiterals('foo|bar'), null);
});

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

test('a corrupt cached shard is replaced from the network', async t => {
    const indexDirectory = sampleIndex(t);
    const storage = fakeCacheStorage();
    const requests = [];
    const searcher = new BrowserReverseSearcher(BASE_URL, fileFetch(indexDirectory, requests), { cacheStorage: storage });
    await searcher.load();
    const cache = await storage.open(`pluginhub-index-${searcher.manifest.build}`);
    for (let shard = 0; shard < searcher.manifest.shardCount; shard++) {
        cache.entries.set(`${BASE_URL}shards/${String(shard).padStart(4, '0')}.bin?v=${searcher.manifest.build}`, new Uint8Array([1, 2, 3]));
    }
    assert.equal((await find(searcher, 'Toa Keris Cam', { caseSensitive: true })).length, 1);
    assert.ok(requests.some(name => name.startsWith('shards/')));
});
