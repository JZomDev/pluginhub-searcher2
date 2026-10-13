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
