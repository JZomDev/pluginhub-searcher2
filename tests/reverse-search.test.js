const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { ReverseSearcher } = require('../scripts/reverse-search.js');
const { BrowserReverseSearcher } = require('../scripts/reverse-search-browser.js');

function indexFiles(indexPath) {
    const directory = path.dirname(indexPath);
    const prefix = `${path.basename(indexPath)}.part-`;
    return fs.readdirSync(directory)
        .filter(name => name.startsWith(prefix))
        .sort()
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
                'Keris appears on this different line'
            ].join('\r\n')
        }]
    }));
    fs.writeFileSync(path.join(dataDirectory, 'second-plugin.json'), JSON.stringify({
        files: [{ filePath: 'src/Other.java', content: 'Toa unrelated\n' }]
    }));

    const indexDirectory = path.join(temporaryDirectory, 'index');
    const indexPath = path.join(indexDirectory, 'search.ridx');
    const python = process.env.PYTHON || (fs.existsSync('/Library/Frameworks/Python.framework/Versions/3.13/bin/python3')
        ? '/Library/Frameworks/Python.framework/Versions/3.13/bin/python3'
        : 'python3');
    execFileSync(python, [
        path.join(__dirname, '..', 'build_reverse_index.py'),
        dataDirectory,
        indexPath,
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
    assert.deepEqual(indexFiles(indexPath), indexFiles(serialIndexPath));
    const manifest = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    assert.equal(manifest.format, 'RVS1-sharded');
    for (const [, part] of indexFiles(indexPath)) assert.ok(part.length <= manifest.partSize);

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

    const manifestBytes = fs.readFileSync(indexPath);
    const requestedParts = [];
    const shardFetch = async url => {
        if (url === 'https://pages.example/search.ridx') {
            return {
                status: 200,
                headers: { get: name => name.toLowerCase() === 'content-length' ? String(manifestBytes.length) : null },
                arrayBuffer: async () => manifestBytes.buffer.slice(
                    manifestBytes.byteOffset, manifestBytes.byteOffset + manifestBytes.byteLength)
            };
        }
        const partMatch = url.match(/\.part-(\d+)$/);
        assert.ok(partMatch);
        requestedParts.push(Number(partMatch[1]));
        const part = fs.readFileSync(`${indexPath}.part-${partMatch[1]}`);
        return {
            status: 200,
            headers: { get: name => name.toLowerCase() === 'content-length' ? String(part.length) : null },
            body: null,
            arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength)
        };
    };
    const browserSearcher = new BrowserReverseSearcher('https://pages.example/search.ridx', shardFetch);
    await browserSearcher.load();
    assert.deepEqual(requestedParts, Array.from({ length: manifest.partCount }, (_, index) => index));
    const browserResult = await browserSearcher.search('Toa Keris Cam', { caseSensitive: true });
    assert.deepEqual(browserResult, phrase.results);
    assert.equal((await browserSearcher.search('PouchPlacement')).length, 1);
});