const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { ReverseSearcher } = require('../scripts/reverse-search.js');
const { BrowserReverseSearcher } = require('../scripts/reverse-search-browser.js');

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
                'Keris appears on this different line'
            ].join('\r\n')
        }]
    }));
    fs.writeFileSync(path.join(dataDirectory, 'second-plugin.json'), JSON.stringify({
        files: [{ filePath: 'src/Other.java', content: 'Toa unrelated\n' }]
    }));

    const indexDirectory = path.join(temporaryDirectory, 'index');
    fs.mkdirSync(indexDirectory);
    const indexPath = path.join(indexDirectory, 'search.ridx');
    const python = process.env.PYTHON || (fs.existsSync('/Library/Frameworks/Python.framework/Versions/3.13/bin/python3')
        ? '/Library/Frameworks/Python.framework/Versions/3.13/bin/python3'
        : 'python3');
    execFileSync(python, [
        path.join(__dirname, '..', 'build_reverse_index.py'),
        dataDirectory,
        indexDirectory,
        '2'
    ], { stdio: 'pipe' });

    const serialIndexPath = path.join(temporaryDirectory, 'serial.ridx');
    execFileSync(python, [
        path.join(__dirname, '..', 'build_reverse_index.py'),
        dataDirectory,
        serialIndexPath,
        '1'
    ], { stdio: 'pipe' });
    assert.deepEqual(fs.readFileSync(indexPath), fs.readFileSync(serialIndexPath));

    const searcher = new ReverseSearcher();
    t.after(() => searcher.close());
    searcher.loadIndex(indexPath);

    const phrase = searcher.search('Toa Keris Cam', { caseSensitive: true });
    assert.equal(phrase.count, 1);
    assert.deepEqual(phrase.results[0], {
        plugin: 'zom-keris-cam',
        repository: 'https://github.com/example/zom-keris-cam.git',
        commit: 'abc123',
        filePath: 'src/main/java/com/zom/TOAKerisCamPlugin.java',
        line: 3,
        content: '\tname = "Toa Keris Cam"'
    });

    assert.equal(searcher.search('PouchPlacement').count, 1);
    assert.equal(searcher.search('visible phrase').count, 1);
    assert.equal(searcher.search('VISIBLE PHRASE', { caseSensitive: true }).count, 0);
    assert.equal(searcher.search('metadata-only-needle').count, 0);
    assert.equal(searcher.search('Toa Keris').count, 1);
    assert.equal(searcher.search('Keris Toa').count, 0);

    const artifact = fs.readFileSync(indexPath);
    const rangeFetch = async (url, request) => {
        const match = request.headers.Range.match(/^bytes=(\d+)-(\d+)$/);
        const start = Number(match[1]);
        const end = Number(match[2]);
        const bytes = artifact.subarray(start, end + 1);
        return {
            status: 206,
            headers: { get: name => name.toLowerCase() === 'content-range'
                ? `bytes ${start}-${end}/${artifact.length}`
                : null },
            arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        };
    };
    const browserSearcher = new BrowserReverseSearcher('https://pages.example/search.ridx', rangeFetch);
    await browserSearcher.load();
    const browserResult = await browserSearcher.search('Toa Keris Cam', { caseSensitive: true });
    assert.deepEqual(browserResult, phrase.results);
    assert.equal((await browserSearcher.search('PouchPlacement')).length, 1);

    const noRangeFetcher = async () => ({
        status: 200,
        headers: { get: name => name.toLowerCase() === 'content-length' ? String(artifact.length) : null },
        body: null,
        arrayBuffer: async () => artifact.buffer.slice(artifact.byteOffset, artifact.byteOffset + artifact.byteLength)
    });
    const fallbackSearcher = new BrowserReverseSearcher('https://pages.example/search.ridx', noRangeFetcher);
    await fallbackSearcher.load();
    assert.deepEqual(await fallbackSearcher.search('Toa Keris Cam', { caseSensitive: true }), phrase.results);
});