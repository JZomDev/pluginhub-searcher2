const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { BrowserReverseSearcher, requiredRegexLiterals } = require('../scripts/reverse-search-browser.js');

const python = process.env.PYTHON || 'python3';

function buildIndex(dataDirectory, indexDirectory, workers) {
    execFileSync(python, [
        path.join(__dirname, '..', 'build_reverse_index.py'),
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

function listFiles(directory) {
    return fs.readdirSync(directory, { recursive: true }).sort()
        .filter(name => fs.statSync(path.join(directory, name)).isFile())
        .map(name => [name, fs.readFileSync(path.join(directory, name))]);
}

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

    const phrase = await searcher.search('Toa Keris Cam', { caseSensitive: true });
    assert.deepEqual(phrase, [{
        plugin: 'zom-keris-cam',
        repository: 'https://github.com/example/zom-keris-cam.git',
        commit: 'abc123',
        filePath: 'src/main/java/com/zom/TOAKerisCamPlugin.java',
        line: 3,
        content: '\tname = "Toa Keris Cam"'
    }]);

    assert.equal((await searcher.search('PouchPlacement')).length, 1);
    assert.equal((await searcher.search('visible phrase')).length, 1);
    assert.equal((await searcher.search('VISIBLE PHRASE', { caseSensitive: true })).length, 0);
    assert.equal((await searcher.search('metadata-only-needle')).length, 0);
    assert.equal((await searcher.search('Toa Keris')).length, 1);
    assert.equal((await searcher.search('Keris Toa')).length, 0);
    assert.equal((await searcher.search('Toa')).length, 3);

    // Regex queries use the index through their required literals.
    requests.length = 0;
    const regex = await searcher.search('client.getLocalPlayer', { isRegex: true, caseSensitive: true });
    assert.deepEqual(regex.map(result => result.plugin), ['second-plugin', 'zom-keris-cam']);
    assert.ok(requests.every(name => !name.startsWith('manifest')));
    assert.equal((await searcher.search('client\\.getLocal', { isRegex: true })).length, 1);
    assert.equal((await searcher.search('^Toa (happens|unrelated)', { isRegex: true, caseSensitive: true })).length, 2);

    // Queries with no usable trigram fall back to scanning every chunk.
    assert.equal((await searcher.search('^.{0,2}$', { isRegex: true })).length, 1);
    assert.equal((await searcher.search('zz')).length, 0);
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
