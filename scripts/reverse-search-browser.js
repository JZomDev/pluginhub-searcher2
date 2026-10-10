(function (root) {
    'use strict';

    const HEADER_SIZE = 88;
    const GRAM_ENTRY_SIZE = 20;
    const MAX_INDEX_PART_SIZE = 75 * 1000 * 1000;
    const MAX_MANIFEST_SIZE = 1024 * 1024;
    const MAX_FILE_TABLE_SIZE = 32 * 1024 * 1024;
    const MAX_POSTING_SIZE = 128 * 1024 * 1024;
    const MAX_SOURCE_SIZE = 8 * 1024 * 1024;

    async function readResponseBounded(response, maximumBytes) {
        const contentLength = response.headers.get('Content-Length');
        const declaredLength = contentLength === null ? NaN : Number(contentLength);
        if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
            throw new Error('Response exceeds its configured size limit');
        }
        if (!response.body) {
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.length > maximumBytes) throw new Error('Response exceeds its configured size limit');
            return bytes;
        }
        const reader = response.body.getReader();
        if (Number.isSafeInteger(declaredLength) && declaredLength >= 0) {
            const bytes = new Uint8Array(declaredLength);
            let offset = 0;
            while (true) {
                const result = await reader.read();
                if (result.done) break;
                if (offset + result.value.length > bytes.length) {
                    await reader.cancel();
                    throw new Error('Response exceeds its declared length');
                }
                bytes.set(result.value, offset);
                offset += result.value.length;
            }
            if (offset !== declaredLength) throw new Error('Response is shorter than its declared length');
            return bytes;
        }
        const chunks = [];
        let total = 0;
        while (true) {
            const result = await reader.read();
            if (result.done) break;
            total += result.value.length;
            if (total > maximumBytes) {
                await reader.cancel();
                throw new Error('Response exceeds its configured size limit');
            }
            chunks.push(result.value);
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
        }
        return bytes;
    }

    function readU64(view, offset) {
        const value = view.getBigUint64(offset, true);
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Index offset exceeds safe integer range');
        return Number(value);
    }

    function getGrams(value) {
        const bytes = new TextEncoder().encode(value.toLowerCase());
        const unique = new Set();
        if (bytes.length < 3) return [];
        for (let offset = 0; offset + 3 <= bytes.length; offset++) {
            let hex = '';
            for (let index = offset; index < offset + 3; index++) {
                hex += bytes[index].toString(16).padStart(2, '0');
            }
            unique.add(`3:${hex}`);
        }
        return [...unique];
    }

    async function gunzipBounded(compressed, maximumSize, expectedSize) {
        if (typeof DecompressionStream !== 'function') {
            throw new Error('This browser does not support gzip decompression');
        }
        const reader = new Blob([compressed])
            .stream()
            .pipeThrough(new DecompressionStream('gzip'))
            .getReader();
        const chunks = [];
        let total = 0;
        while (true) {
            const result = await reader.read();
            if (result.done) break;
            total += result.value.length;
            if (total > maximumSize || (expectedSize !== undefined && total > expectedSize)) {
                await reader.cancel();
                throw new Error('Decompressed block exceeds its declared size');
            }
            chunks.push(result.value);
        }
        if (expectedSize !== undefined && total !== expectedSize) {
            throw new Error('Decompressed block size mismatch');
        }
        const output = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            output.set(chunk, offset);
            offset += chunk.length;
        }
        return output;
    }

    function decodePosting(bytes, count, lineCount) {
        const lines = new Uint32Array(count);
        let offset = 0;
        let previous = -1;
        for (let index = 0; index < count; index++) {
            let delta = 0;
            let shift = 0;
            while (true) {
                if (offset >= bytes.length || shift > 28) throw new Error('Malformed posting varint');
                const byte = bytes[offset++];
                delta |= (byte & 0x7f) << shift;
                if ((byte & 0x80) === 0) break;
                shift += 7;
            }
            const lineId = previous + delta;
            if (delta <= 0 || lineId < 0 || lineId >= lineCount) throw new Error('Invalid posting line ID');
            lines[index] = lineId;
            previous = lineId;
        }
        if (offset !== bytes.length) throw new Error('Posting list has trailing data');
        return lines;
    }

    function splitLines(source) {
        if (!source.length) return [];
        const lines = source.split(/\r\n|\n|\r/);
        if (/(?:\r\n|\n|\r)$/.test(source)) lines.pop();
        return lines;
    }

    class BrowserReverseSearcher {
        constructor(indexUrl, fetchFunction = root.fetch.bind(root)) {
            this.indexUrl = indexUrl;
            this.fetch = fetchFunction;
            this.partSize = 0;
            this.partCount = 0;
            this.artifactSize = 0;
            this.artifact = null;
            this.textOffset = 0;
            this.textSize = 0;
            this.lineCount = 0;
            this.grams = new Map();
            this.files = [];
            this.postingCache = new Map();
            this.sourceCache = new Map();
        }

        async _range(offset, length) {
            if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0 ||
                offset + length > this.artifactSize || !this.artifact) {
                throw new Error('Requested index range is invalid');
            }
            return this.artifact.slice(offset, offset + length);
        }

        async _loadPart(partNumber, output) {
            const offset = partNumber * this.partSize;
            const expectedSize = Math.min(this.partSize, this.artifactSize - offset);
            const shardUrl = new URL(this.indexUrl);
            shardUrl.pathname += `.part-${String(partNumber).padStart(5, '0')}`;
            const response = await this.fetch(shardUrl.href);
            if (response.status !== 200) {
                throw new Error(`Could not fetch index shard: HTTP ${response.status}`);
            }

            // Content-Length is the encoded size when the server compresses the shard
            // (GitHub Pages gzips it), so only trust it for uncompressed responses.
            const contentLength = response.headers.get('Content-Length');
            const contentEncoding = response.headers.get('Content-Encoding');
            if (contentLength !== null && (!contentEncoding || contentEncoding === 'identity') &&
                Number(contentLength) !== expectedSize) {
                throw new Error('Server returned an invalid index shard size');
            }
            if (!response.body) {
                const bytes = new Uint8Array(await response.arrayBuffer());
                if (bytes.length !== expectedSize) throw new Error('Server returned an invalid index shard size');
                output.set(bytes, offset);
                return;
            }

            const reader = response.body.getReader();
            let written = 0;
            while (true) {
                const result = await reader.read();
                if (result.done) break;
                if (written + result.value.length > expectedSize) {
                    await reader.cancel();
                    throw new Error('Index shard exceeds its declared size');
                }
                output.set(result.value, offset + written);
                written += result.value.length;
            }
            if (written !== expectedSize) throw new Error('Server returned an incomplete index shard');
        }

        async load() {
            const manifestResponse = await this.fetch(this.indexUrl);
            if (manifestResponse.status !== 200) {
                throw new Error(`Could not load search index manifest: HTTP ${manifestResponse.status}`);
            }
            const manifestBytes = await readResponseBounded(manifestResponse, MAX_MANIFEST_SIZE);
            const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
            if (!manifest || manifest.format !== 'RVS1-sharded' || manifest.version !== 1 ||
                !Number.isSafeInteger(manifest.artifactSize) || manifest.artifactSize < HEADER_SIZE ||
                manifest.partSize !== MAX_INDEX_PART_SIZE ||
                !Number.isSafeInteger(manifest.partCount) || manifest.partCount <= 0 ||
                manifest.partCount !== Math.ceil(manifest.artifactSize / manifest.partSize)) {
                throw new Error('Invalid reverse index shard manifest');
            }
            this.artifactSize = manifest.artifactSize;
            this.partSize = manifest.partSize;
            this.partCount = manifest.partCount;
            this.artifact = new Uint8Array(this.artifactSize);
            for (let partNumber = 0; partNumber < this.partCount; partNumber++) {
                await this._loadPart(partNumber, this.artifact);
            }
            const headerBytes = await this._range(0, HEADER_SIZE);

            if (headerBytes.length !== HEADER_SIZE ||
                String.fromCharCode(...headerBytes.subarray(0, 4)) !== 'RVS1') {
                throw new Error('Invalid reverse index header');
            }
            const view = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
            if (view.getUint32(4, true) !== 1) throw new Error('Unsupported reverse index version');
            this.lineCount = readU64(view, 8);
            const gramCount = view.getUint32(16, true);
            const fileCount = view.getUint32(20, true);
            const dictionaryOffset = readU64(view, 24);
            const dictionarySize = readU64(view, 32);
            this.postingsOffset = readU64(view, 40);
            this.postingsSize = readU64(view, 48);
            const filesOffset = readU64(view, 56);
            const filesSize = readU64(view, 64);
            this.textOffset = readU64(view, 72);
            this.textSize = readU64(view, 80);

            if (this.lineCount <= 0 || gramCount <= 0 || fileCount <= 0 ||
                dictionaryOffset !== HEADER_SIZE || dictionarySize !== gramCount * GRAM_ENTRY_SIZE ||
                this.postingsOffset !== dictionaryOffset + dictionarySize ||
                filesOffset !== this.postingsOffset + this.postingsSize ||
                this.textOffset !== filesOffset + filesSize ||
                this.textOffset + this.textSize !== this.artifactSize ||
                filesSize > MAX_FILE_TABLE_SIZE) throw new Error('Invalid reverse index sections');

            const dictionaryBytes = await this._range(dictionaryOffset, dictionarySize);
            const dictionaryView = new DataView(dictionaryBytes.buffer, dictionaryBytes.byteOffset, dictionaryBytes.byteLength);
            for (let index = 0; index < gramCount; index++) {
                const offset = index * GRAM_ENTRY_SIZE;
                const width = dictionaryBytes[offset + 3];
                if (width < 1 || width > 3) throw new Error('Invalid n-gram width');
                let hex = '';
                for (let byteIndex = 0; byteIndex < width; byteIndex++) {
                    hex += dictionaryBytes[offset + byteIndex].toString(16).padStart(2, '0');
                }
                this.grams.set(`${width}:${hex}`, {
                    offset: readU64(dictionaryView, offset + 4),
                    compressedSize: dictionaryView.getUint32(offset + 12, true),
                    count: dictionaryView.getUint32(offset + 16, true)
                });
            }

            const fileTableBytes = await this._range(filesOffset, filesSize);
            this.files = JSON.parse(new TextDecoder().decode(fileTableBytes));
            if (!Array.isArray(this.files) || this.files.length !== fileCount) throw new Error('Invalid source file table');
            let nextLine = 0;
            for (const file of this.files) {
                if (!Number.isSafeInteger(file.firstLine) || !Number.isSafeInteger(file.lineCount) ||
                    file.firstLine !== nextLine || file.lineCount < 0 ||
                    !Number.isSafeInteger(file.offset) || !Number.isSafeInteger(file.compressedSize) ||
                    !Number.isSafeInteger(file.rawSize) || file.rawSize > MAX_SOURCE_SIZE ||
                    file.offset + file.compressedSize > this.textSize) throw new Error('Invalid source file record');
                nextLine += file.lineCount;
            }
            if (nextLine !== this.lineCount) throw new Error('Source file line ranges do not cover the index');
            return this.lineCount;
        }

        async _getPosting(gram, descriptor) {
            if (this.postingCache.has(gram)) return this.postingCache.get(gram);
            if (descriptor.compressedSize > MAX_POSTING_SIZE ||
                descriptor.offset + descriptor.compressedSize > this.postingsSize) throw new Error('Invalid posting bounds');
            const compressed = await this._range(this.postingsOffset + descriptor.offset, descriptor.compressedSize);
            const raw = await gunzipBounded(compressed, MAX_POSTING_SIZE);
            const posting = decodePosting(raw, descriptor.count, this.lineCount);
            this.postingCache.set(gram, posting);
            if (this.postingCache.size > 24) this.postingCache.delete(this.postingCache.keys().next().value);
            return posting;
        }

        _findFile(lineId) {
            let low = 0;
            let high = this.files.length;
            while (low < high) {
                const middle = (low + high) >>> 1;
                if (this.files[middle].firstLine + this.files[middle].lineCount <= lineId) low = middle + 1;
                else high = middle;
            }
            const file = this.files[low];
            return file && lineId >= file.firstLine ? low : -1;
        }

        async _getSource(fileIndex) {
            if (this.sourceCache.has(fileIndex)) return this.sourceCache.get(fileIndex);
            const file = this.files[fileIndex];
            const compressed = await this._range(this.textOffset + file.offset, file.compressedSize);
            const sourceBytes = await gunzipBounded(compressed, MAX_SOURCE_SIZE, file.rawSize);
            const lines = splitLines(new TextDecoder().decode(sourceBytes));
            if (lines.length !== file.lineCount) throw new Error('Source line count mismatch');
            this.sourceCache.set(fileIndex, lines);
            if (this.sourceCache.size > 8) this.sourceCache.delete(this.sourceCache.keys().next().value);
            return lines;
        }

        async search(query, options = {}) {
            const caseSensitive = options.caseSensitive === true;
            const isRegex = options.isRegex === true;
            const normalizedQuery = caseSensitive ? query : query.toLowerCase();
            let pattern = null;
            if (isRegex) pattern = new RegExp(query, caseSensitive ? '' : 'i');
            const canUseTrigrams = !isRegex || !/[.*+?^${}()|[\]\\]/.test(query);
            const grams = canUseTrigrams ? getGrams(normalizedQuery) : [];
            let candidateIds;
            if (!grams.length) {
                const results = [];
                for (let fileIndex = 0; fileIndex < this.files.length; fileIndex++) {
                    const file = this.files[fileIndex];
                    const lines = await this._getSource(fileIndex);
                    for (let index = 0; index < lines.length; index++) {
                        const searchable = caseSensitive ? lines[index] : lines[index].toLowerCase();
                        const matches = pattern ? pattern.test(lines[index]) : searchable.includes(normalizedQuery);
                        if (matches) {
                            results.push({ plugin: file.plugin, repository: file.repository, commit: file.commit, filePath: file.path, line: index + 1, content: lines[index] });
                        }
                    }
                }
                results.sort((left, right) => `${left.plugin}\0${left.filePath}\0${left.line}`
                    .localeCompare(`${right.plugin}\0${right.filePath}\0${right.line}`));
                return results;
            } else {
                let rarestGram = null;
                let rarest = null;
                for (const gram of grams) {
                    const descriptor = this.grams.get(gram);
                    if (!descriptor) return [];
                    if (!rarest || descriptor.count < rarest.count) {
                        rarest = descriptor;
                        rarestGram = gram;
                    }
                }
                candidateIds = await this._getPosting(rarestGram, rarest);
            }

            const grouped = new Map();
            for (const lineId of candidateIds) {
                const fileIndex = this._findFile(lineId);
                if (fileIndex < 0) throw new Error(`No source file for line ${lineId}`);
                if (!grouped.has(fileIndex)) grouped.set(fileIndex, []);
                grouped.get(fileIndex).push(lineId);
            }

            const results = [];
            for (const [fileIndex, lineIds] of grouped) {
                const file = this.files[fileIndex];
                const lines = await this._getSource(fileIndex);
                for (const lineId of lineIds) {
                    const content = lines[lineId - file.firstLine];
                    const searchable = caseSensitive ? content : content.toLowerCase();
                    const matches = pattern ? pattern.test(content) : searchable.includes(normalizedQuery);
                    if (!matches) continue;
                    results.push({ plugin: file.plugin, repository: file.repository, commit: file.commit, filePath: file.path, line: lineId - file.firstLine + 1, content });
                }
            }
            results.sort((left, right) => {
                const a = `${left.plugin}\0${left.filePath}\0${left.line}`;
                const b = `${right.plugin}\0${right.filePath}\0${right.line}`;
                return a.localeCompare(b);
            });
            return results;
        }
    }

    const api = { BrowserReverseSearcher };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.ReverseSearchBrowser = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);