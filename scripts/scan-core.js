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
