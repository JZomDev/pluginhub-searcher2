const fs = require('fs');
const zlib = require('zlib');

const HEADER_SIZE = 88;
const HEADER = Object.freeze({
    magic: 0,
    version: 4,
    lineCount: 8,
    gramCount: 16,
    fileCount: 20,
    dictionaryOffset: 24,
    dictionarySize: 32,
    postingsOffset: 40,
    postingsSize: 48,
    filesOffset: 56,
    filesSize: 64,
    textOffset: 72,
    textSize: 80
});
const GRAM_ENTRY_SIZE = 20;
const MAX_FILE_TABLE_SIZE = 32 * 1024 * 1024;
const MAX_POSTING_COMPRESSED_SIZE = 32 * 1024 * 1024;
const MAX_POSTING_DECOMPRESSED_SIZE = 128 * 1024 * 1024;
const MAX_SOURCE_SIZE = 8 * 1024 * 1024;
const MAX_INDEX_PART_SIZE = 75 * 1000 * 1000;

function encodeGrams(text) {
    const bytes = Buffer.from(text.toLowerCase(), 'utf8');
    const grams = new Map();
    if (bytes.length < 3) return [];
    for (let offset = 0; offset + 3 <= bytes.length; offset++) {
        const gram = `3:${bytes.subarray(offset, offset + 3).toString('hex')}`;
        grams.set(gram, true);
    }
    return [...grams.keys()];
}

function decodeDeltas(buffer, expectedCount, lineCount) {
    const lines = new Array(expectedCount);
    let offset = 0;
    let previous = -1;
    for (let index = 0; index < expectedCount; index++) {
        let delta = 0;
        let shift = 0;
        while (true) {
            if (offset >= buffer.length || shift > 28) throw new Error('Malformed posting varint');
            const byte = buffer[offset++];
            delta |= (byte & 0x7f) << shift;
            if ((byte & 0x80) === 0) break;
            shift += 7;
        }
        const lineId = previous + delta;
        if (delta <= 0 || lineId < 0 || lineId >= lineCount) throw new Error('Invalid posting line ID');
        lines[index] = lineId;
        previous = lineId;
    }
    if (offset !== buffer.length) throw new Error('Posting list has trailing data');
    return lines;
}

function splitSourceLines(source) {
    if (source.length === 0) return [];
    const lines = source.split(/\r\n|\n|\r/);
    if (/(?:\r\n|\n|\r)$/.test(source)) lines.pop();
    return lines;
}

class ReverseSearcher {
    constructor() {
        this.fd = null;
        this.indexPath = null;
        this.partSize = 0;
        this.partCount = 0;
        this.fileSize = 0;
        this.lineCount = 0;
        this.grams = new Map();
        this.files = [];
        this.postingCache = new Map();
        this.sourceCache = new Map();
    }

    loadIndex(indexPath) {
        this.close();
        this.fd = fs.openSync(indexPath, 'r');
        this.fileSize = fs.fstatSync(this.fd).size;
        const prefix = Buffer.alloc(4);
        fs.readSync(this.fd, prefix, 0, prefix.length, 0);
        if (prefix.toString('ascii') !== 'RVS1') {
            const manifestBytes = fs.readFileSync(indexPath);
            fs.closeSync(this.fd);
            this.fd = null;
            this.indexPath = indexPath;
            this._configureParts(JSON.parse(manifestBytes.toString('utf8')));
        }
        if (this.fileSize < HEADER_SIZE) throw new Error('Truncated reverse index header');
        const header = this._read(0, HEADER_SIZE);
        if (header.toString('ascii', 0, 4) !== 'RVS1') throw new Error('Invalid reverse index magic');
        if (header.readUInt32LE(4) !== 1) throw new Error('Unsupported reverse index version');

        this.lineCount = Number(header.readBigUInt64LE(8));
        const gramCount = header.readUInt32LE(16);
        const fileCount = header.readUInt32LE(20);
        this.sections = {
            dictionaryOffset: Number(header.readBigUInt64LE(24)),
            dictionarySize: Number(header.readBigUInt64LE(32)),
            postingsOffset: Number(header.readBigUInt64LE(40)),
            postingsSize: Number(header.readBigUInt64LE(48)),
            filesOffset: Number(header.readBigUInt64LE(56)),
            filesSize: Number(header.readBigUInt64LE(64)),
            textOffset: Number(header.readBigUInt64LE(72)),
            textSize: Number(header.readBigUInt64LE(80))
        };
        this._validateSections(gramCount, fileCount);

        const dictionary = this._read(this.sections.dictionaryOffset, this.sections.dictionarySize);
        for (let index = 0; index < gramCount; index++) {
            const offset = index * GRAM_ENTRY_SIZE;
            const width = dictionary[offset + 3];
            if (width < 1 || width > 3) throw new Error('Invalid n-gram width');
            const gram = `${width}:${dictionary.subarray(offset, offset + width).toString('hex')}`;
            const postingOffset = Number(dictionary.readBigUInt64LE(offset + 4));
            const compressedSize = dictionary.readUInt32LE(offset + 12);
            const count = dictionary.readUInt32LE(offset + 16);
            this.grams.set(gram, { offset: postingOffset, compressedSize, count });
        }

        const filesJson = this._read(this.sections.filesOffset, this.sections.filesSize).toString('utf8');
        this.files = JSON.parse(filesJson);
        if (!Array.isArray(this.files) || this.files.length !== fileCount) throw new Error('Invalid source file table');
        let nextLine = 0;
        for (const file of this.files) {
            if (!Number.isSafeInteger(file.firstLine) || !Number.isSafeInteger(file.lineCount) ||
                file.firstLine !== nextLine || file.lineCount < 0 ||
                !Number.isSafeInteger(file.offset) || !Number.isSafeInteger(file.compressedSize) ||
                !Number.isSafeInteger(file.rawSize) || file.rawSize > MAX_SOURCE_SIZE) {
                throw new Error('Invalid source file record');
            }
            nextLine += file.lineCount;
        }
        if (nextLine !== this.lineCount) throw new Error('Source file line ranges do not cover the index');
        return this.lineCount;
    }

    _configureParts(manifest) {
        if (!manifest || manifest.format !== 'RVS1-sharded' || manifest.version !== 1 ||
            !Number.isSafeInteger(manifest.artifactSize) || manifest.artifactSize < HEADER_SIZE ||
            manifest.partSize !== MAX_INDEX_PART_SIZE ||
            !Number.isSafeInteger(manifest.partCount) || manifest.partCount <= 0 ||
            manifest.partCount !== Math.ceil(manifest.artifactSize / manifest.partSize)) {
            throw new Error('Invalid reverse index shard manifest');
        }
        this.fileSize = manifest.artifactSize;
        this.partSize = manifest.partSize;
        this.partCount = manifest.partCount;
    }

    _validateSections(gramCount, fileCount) {
        const sections = this.sections;
        if (!Number.isSafeInteger(this.lineCount) || this.lineCount <= 0 ||
            !Number.isSafeInteger(gramCount) || gramCount <= 0 || fileCount <= 0 ||
            sections.dictionaryOffset !== HEADER_SIZE ||
            sections.dictionarySize !== gramCount * GRAM_ENTRY_SIZE ||
            sections.postingsOffset !== sections.dictionaryOffset + sections.dictionarySize ||
            sections.filesOffset !== sections.postingsOffset + sections.postingsSize ||
            sections.textOffset !== sections.filesOffset + sections.filesSize ||
            sections.textOffset + sections.textSize !== this.fileSize ||
            sections.filesSize > MAX_FILE_TABLE_SIZE) {
            throw new Error('Invalid reverse index section bounds');
        }
    }

    _read(offset, length) {
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
            offset + length > this.fileSize) throw new Error('Index read is out of bounds');
        const buffer = Buffer.alloc(length);
        if (this.partCount > 0) {
            let copied = 0;
            while (copied < length) {
                const absoluteOffset = offset + copied;
                const partNumber = Math.floor(absoluteOffset / this.partSize);
                const partOffset = absoluteOffset % this.partSize;
                const partPath = `${this.indexPath}.part-${String(partNumber).padStart(5, '0')}`;
                const partFd = fs.openSync(partPath, 'r');
                try {
                    const count = fs.readSync(partFd, buffer, copied,
                        Math.min(length - copied, this.partSize - partOffset), partOffset);
                    if (count === 0) throw new Error('Unexpected end of reverse index shard');
                    copied += count;
                } finally {
                    fs.closeSync(partFd);
                }
            }
            return buffer;
        }
        let read = 0;
        while (read < length) {
            const count = fs.readSync(this.fd, buffer, read, length - read, offset + read);
            if (count === 0) throw new Error('Unexpected end of reverse index');
            read += count;
        }
        return buffer;
    }

    _getPosting(gram) {
        if (this.postingCache.has(gram)) return this.postingCache.get(gram);
        const descriptor = this.grams.get(gram);
        if (!descriptor) return null;
        if (descriptor.compressedSize > MAX_POSTING_COMPRESSED_SIZE ||
            descriptor.offset + descriptor.compressedSize > this.sections.postingsSize) {
            throw new Error('Invalid posting block bounds');
        }
        const compressed = this._read(this.sections.postingsOffset + descriptor.offset, descriptor.compressedSize);
        const raw = zlib.gunzipSync(compressed, { maxOutputLength: MAX_POSTING_DECOMPRESSED_SIZE });
        const posting = decodeDeltas(raw, descriptor.count, this.lineCount);
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

    _getSource(fileIndex) {
        if (this.sourceCache.has(fileIndex)) return this.sourceCache.get(fileIndex);
        const file = this.files[fileIndex];
        if (!file || file.offset + file.compressedSize > this.sections.textSize) throw new Error('Invalid source block bounds');
        const compressed = this._read(this.sections.textOffset + file.offset, file.compressedSize);
        const source = zlib.gunzipSync(compressed, { maxOutputLength: MAX_SOURCE_SIZE });
        if (source.length !== file.rawSize) throw new Error('Source block size mismatch');
        const lines = splitSourceLines(source.toString('utf8'));
        if (lines.length !== file.lineCount) throw new Error('Source line count mismatch');
        this.sourceCache.set(fileIndex, lines);
        if (this.sourceCache.size > 8) this.sourceCache.delete(this.sourceCache.keys().next().value);
        return lines;
    }

    search(query, options = {}) {
        const started = Date.now();
        const caseSensitive = options.caseSensitive === true;
        const normalizedQuery = caseSensitive ? query : query.toLowerCase();
        const queryGrams = encodeGrams(normalizedQuery);
        let candidateIds;

        if (queryGrams.length === 0) {
            const results = [];
            for (let fileIndex = 0; fileIndex < this.files.length; fileIndex++) {
                const file = this.files[fileIndex];
                const lines = this._getSource(fileIndex);
                for (let index = 0; index < lines.length; index++) {
                    const searchable = caseSensitive ? lines[index] : lines[index].toLowerCase();
                    if (searchable.includes(normalizedQuery)) {
                        results.push({ plugin: file.plugin, filePath: file.path, line: index + 1, content: lines[index] });
                    }
                }
            }
            results.sort((left, right) => `${left.plugin}\0${left.filePath}\0${left.line}`
                .localeCompare(`${right.plugin}\0${right.filePath}\0${right.line}`));
            return { results, count: results.length, durationMs: Date.now() - started };
        } else {
            let rarestGram = null;
            let rarestCount = Infinity;
            for (const gram of queryGrams) {
                const descriptor = this.grams.get(gram);
                if (!descriptor) return { results: [], count: 0, durationMs: Date.now() - started };
                if (descriptor.count < rarestCount) {
                    rarestGram = gram;
                    rarestCount = descriptor.count;
                }
            }
            candidateIds = this._getPosting(rarestGram);
        }

        const results = [];
        const filesToLines = new Map();
        for (const lineId of candidateIds) {
            const fileIndex = this._findFile(lineId);
            if (fileIndex < 0) throw new Error(`No source file for line ${lineId}`);
            let lines = filesToLines.get(fileIndex);
            if (!lines) filesToLines.set(fileIndex, lines = []);
            lines.push(lineId);
        }

        for (const [fileIndex, lineIds] of filesToLines) {
            const file = this.files[fileIndex];
            const sourceLines = this._getSource(fileIndex);
            for (const lineId of lineIds) {
                const content = sourceLines[lineId - file.firstLine];
                const searchable = caseSensitive ? content : content.toLowerCase();
                if (!searchable.includes(normalizedQuery)) continue;
                results.push({
                    plugin: file.plugin,
                    repository: file.repository,
                    commit: file.commit,
                    filePath: file.path,
                    line: lineId - file.firstLine + 1,
                    content
                });
            }
        }
        results.sort((left, right) => {
            const a = `${left.plugin}\0${left.filePath}\0${left.line}`;
            const b = `${right.plugin}\0${right.filePath}\0${right.line}`;
            return a.localeCompare(b);
        });
        return { results, count: results.length, durationMs: Date.now() - started };
    }

    close() {
        if (this.fd !== null) fs.closeSync(this.fd);
        this.fd = null;
        this.indexPath = null;
        this.partSize = 0;
        this.partCount = 0;
        this.fileSize = 0;
        this.lineCount = 0;
        this.grams.clear();
        this.files = [];
        this.postingCache.clear();
        this.sourceCache.clear();
    }

    getRecordCount() {
        return this.lineCount;
    }
}

module.exports = { ReverseSearcher };