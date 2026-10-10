(function (root) {
    'use strict';

    // Must match build_reverse_index.py.
    const FORMAT_VERSION = 2;
    const FETCH_CONCURRENCY = 12;
    const CHUNK_CACHE_CHARS = 160 * 1024 * 1024;
    const textEncoder = new TextEncoder();
    const textDecoder = new TextDecoder();

    function shardOf(gram, shardCount) {
        let value = 0x811c9dc5;
        for (const byte of gram) value = Math.imul(value ^ byte, 0x01000193) >>> 0;
        return value % shardCount;
    }

    function gramKey(bytes, offset) {
        return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
    }

    // Trigrams of the lowercased literals. Only all-ASCII trigrams are used so
    // that JS and Python case folding can never disagree.
    function literalGrams(literals) {
        const grams = new Map();
        for (const literal of literals) {
            const bytes = textEncoder.encode(literal.toLowerCase());
            for (let offset = 0; offset + 3 <= bytes.length; offset++) {
                if ((bytes[offset] | bytes[offset + 1] | bytes[offset + 2]) & 0x80) continue;
                grams.set(gramKey(bytes, offset), bytes.slice(offset, offset + 3));
            }
        }
        return grams;
    }

    // Index of the `]` closing the character class opened at `index`.
    function skipClass(source, index) {
        index++;
        if (source[index] === '^') index++;
        if (source[index] === ']') index++;
        for (; index < source.length; index++) {
            if (source[index] === '\\') index++;
            else if (source[index] === ']') return index;
        }
        return -1;
    }

    // Index of the `)` closing the group opened at `index`.
    function skipGroup(source, index) {
        let depth = 0;
        for (; index < source.length; index++) {
            const char = source[index];
            if (char === '\\') index++;
            else if (char === '[') {
                index = skipClass(source, index);
                if (index < 0) return -1;
            } else if (char === '(') depth++;
            else if (char === ')' && --depth === 0) return index;
        }
        return -1;
    }

    // Literal substrings every match of `source` must contain, or null when
    // none can be derived (e.g. top-level alternation). Conservative: groups
    // and classes are skipped rather than analysed.
    function requiredRegexLiterals(source) {
        const literals = [];
        let current = '';
        const flush = () => {
            if (current.length >= 3) literals.push(current);
            current = '';
        };
        for (let index = 0; index < source.length; index++) {
            const char = source[index];
            if (char === '\\') {
                const next = source[++index];
                if (next === undefined) return null;
                if (/[A-Za-z0-9]/.test(next)) {
                    flush();
                    if (next === 'x') index += 2;
                    else if (next === 'c') index += 1;
                    else if (next === 'u') index = source[index + 1] === '{' ? source.indexOf('}', index) : index + 4;
                    else if ((next === 'p' || next === 'P') && source[index + 1] === '{') index = source.indexOf('}', index);
                    else if (next === 'k' && source[index + 1] === '<') index = source.indexOf('>', index);
                    else if (/[0-9]/.test(next)) while (/[0-9]/.test(source[index + 1] || '')) index++;
                    if (index < 0) return null;
                } else {
                    current += next;
                }
            } else if (char === '[' || char === '(') {
                flush();
                index = char === '[' ? skipClass(source, index) : skipGroup(source, index);
                if (index < 0) return null;
            } else if (char === '|') {
                return null;
            } else if (char === '*' || char === '?') {
                current = current.slice(0, -1);
                flush();
            } else if (char === '{' && /^\{\d+(,\d*)?\}/.test(source.slice(index))) {
                if (/^\{0[,}]/.test(source.slice(index))) current = current.slice(0, -1);
                flush();
                index = source.indexOf('}', index);
            } else if (char === '+' || char === '.' || char === '^' || char === '$' || char === ')') {
                flush();
            } else {
                current += char;
            }
        }
        flush();
        return literals;
    }

    function decodePosting(bytes, offset, length, count) {
        const ids = new Int32Array(count);
        const end = offset + length;
        let previous = -1;
        for (let index = 0; index < count; index++) {
            let delta = 0;
            let shift = 0;
            let byte;
            do {
                if (offset >= end) throw new Error('Malformed posting list');
                byte = bytes[offset++];
                delta += (byte & 0x7f) * 2 ** shift;
                shift += 7;
            } while (byte & 0x80);
            previous += delta;
            ids[index] = previous;
        }
        return ids;
    }

    function intersect(left, right) {
        const output = new Int32Array(Math.min(left.length, right.length));
        let size = 0;
        for (let i = 0, j = 0; i < left.length && j < right.length;) {
            if (left[i] < right[j]) i++;
            else if (left[i] > right[j]) j++;
            else { output[size++] = left[i]; i++; j++; }
        }
        return output.subarray(0, size);
    }

    function splitLines(source) {
        if (!source.length) return [];
        const lines = source.split(/\r\n|\n|\r/);
        if (/(?:\r\n|\n|\r)$/.test(source)) lines.pop();
        return lines;
    }

    async function gunzip(bytes) {
        if (typeof DecompressionStream !== 'function') throw new Error('This browser does not support gzip decompression');
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    async function mapConcurrent(items, limit, worker) {
        let next = 0;
        const run = async () => {
            while (next < items.length) {
                const item = items[next++];
                await worker(item);
            }
        };
        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    }

    class BrowserReverseSearcher {
        constructor(indexUrl, fetchFunction = root.fetch.bind(root)) {
            this.baseUrl = String(indexUrl).replace(/\/?$/, '/');
            this.fetch = fetchFunction;
            this.manifest = null;
            this.shardCache = new Map();
            this.chunkCache = new Map();
            this.chunkCacheChars = 0;
        }

        async _fetchGzip(path, init) {
            const response = await this.fetch(new URL(path, this.baseUrl).href, init);
            if (!response.ok) throw new Error(`Could not fetch ${path}: HTTP ${response.status}`);
            return gunzip(new Uint8Array(await response.arrayBuffer()));
        }

        async load() {
            const manifest = JSON.parse(textDecoder.decode(await this._fetchGzip('manifest.bin', { cache: 'no-cache' })));
            if (manifest.version !== FORMAT_VERSION) throw new Error('Unsupported search index version');
            this.manifest = manifest;
            this.chunkEnds = [...manifest.chunks.slice(1), manifest.fileCount];
            return manifest.fileCount;
        }

        _shard(index) {
            if (!this.shardCache.has(index)) {
                const name = `shards/${String(index).padStart(4, '0')}.bin?v=${this.manifest.build}`;
                const promise = this._fetchGzip(name).then(bytes => {
                    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                    const gramCount = view.getUint32(0, true);
                    const entries = new Map();
                    let offset = 4 + gramCount * 11;
                    for (let entry = 0; entry < gramCount; entry++) {
                        const position = 4 + entry * 11;
                        const length = view.getUint32(position + 7, true);
                        entries.set(gramKey(bytes, position), { count: view.getUint32(position + 3, true), offset, length });
                        offset += length;
                    }
                    return { bytes, entries };
                });
                promise.catch(() => this.shardCache.delete(index));
                this.shardCache.set(index, promise);
            }
            return this.shardCache.get(index);
        }

        _chunk(index) {
            const cached = this.chunkCache.get(index);
            if (cached) {
                this.chunkCache.delete(index);
                this.chunkCache.set(index, cached);
                return cached.promise;
            }
            const entry = { size: 0, promise: null };
            const name = `chunks/${String(index).padStart(4, '0')}.bin?v=${this.manifest.build}`;
            entry.promise = this._fetchGzip(name).then(bytes => {
                entry.size = bytes.length;
                this.chunkCacheChars += bytes.length;
                for (const [key, old] of this.chunkCache) {
                    if (this.chunkCacheChars <= CHUNK_CACHE_CHARS || old === entry) break;
                    this.chunkCache.delete(key);
                    this.chunkCacheChars -= old.size;
                }
                return JSON.parse(textDecoder.decode(bytes));
            });
            entry.promise.catch(() => {
                this.chunkCache.delete(index);
                this.chunkCacheChars -= entry.size;
            });
            this.chunkCache.set(index, entry);
            return entry.promise;
        }

        // Sorted candidate file ids, or null when every file must be scanned.
        async _candidates(literals) {
            const grams = literalGrams(literals);
            if (!grams.size) return null;
            const { shardCount } = this.manifest;
            const lookups = await Promise.all([...grams].map(async ([key, bytes]) => {
                const shard = await this._shard(shardOf(bytes, shardCount));
                return { shard, descriptor: shard.entries.get(key) };
            }));
            if (lookups.some(lookup => !lookup.descriptor)) return new Int32Array(0);
            lookups.sort((left, right) => left.descriptor.count - right.descriptor.count);
            let candidates = null;
            for (const { shard, descriptor } of lookups) {
                const ids = decodePosting(shard.bytes, descriptor.offset, descriptor.length, descriptor.count);
                candidates = candidates ? intersect(candidates, ids) : ids;
                if (!candidates.length) break;
            }
            return candidates;
        }

        async search(query, options = {}) {
            if (!this.manifest) throw new Error('Search index is not loaded');
            const caseSensitive = options.caseSensitive === true;
            const isRegex = options.isRegex === true;
            const pattern = isRegex ? new RegExp(query, caseSensitive ? '' : 'i') : null;
            const needle = caseSensitive ? query : query.toLowerCase();
            const literals = isRegex ? requiredRegexLiterals(query) : [query];
            const candidates = literals ? await this._candidates(literals) : null;

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

            const results = [];
            await mapConcurrent([...wanted], FETCH_CONCURRENCY, async ([chunk, fileIds]) => {
                const files = await this._chunk(chunk);
                const first = chunks[chunk];
                const ids = fileIds || files.map((_, index) => first + index);
                for (const fileId of ids) {
                    const [pluginIndex, filePath, content] = files[fileId - first];
                    const searchable = caseSensitive ? content : content.toLowerCase();
                    if (!pattern && !searchable.includes(needle)) continue;
                    const lines = splitLines(content);
                    const [plugin, repository, commit] = plugins[pluginIndex];
                    for (let index = 0; index < lines.length; index++) {
                        const line = lines[index];
                        const matches = pattern
                            ? pattern.test(line)
                            : (caseSensitive ? line : line.toLowerCase()).includes(needle);
                        if (matches) {
                            results.push({ fileId, plugin, repository, commit, filePath, line: index + 1, content: line });
                        }
                    }
                }
            });
            results.sort((left, right) => left.fileId - right.fileId || left.line - right.line);
            return results.map(({ fileId, ...result }) => result);
        }
    }

    const api = { BrowserReverseSearcher, requiredRegexLiterals };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.ReverseSearchBrowser = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
