/**
 * Decompress and parse JSON data (supports gzip compression).
 * 
 * @param {ArrayBuffer|Buffer} buf - The compressed or uncompressed JSON data
 * @returns {Promise<Object>} The parsed JSON object
 */
async function decodeJson(buf) {
    const bytes = new Uint8Array(buf);
    let text;
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
        const stream = new Response(buf).body.pipeThrough(new DecompressionStream("gzip"));
        text = await new Response(stream).text();
    } else {
        text = new TextDecoder("utf-8").decode(buf);
    }
    return JSON.parse(text);
}

/**
 * Decompress and parse JSON data with progress callback (supports gzip compression).
 * 
 * @param {ArrayBuffer|Buffer} buf - The compressed or uncompressed JSON data
 * @param {Function} onProgress - Progress callback function
 * @returns {Promise<Object>} The parsed JSON object
 */
async function decodeJsonWithProgress(buf, onProgress = () => {}) {
    const bytes = new Uint8Array(buf);
    let text;
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
        const stream = new Response(buf).body.pipeThrough(new DecompressionStream("gzip"));
        text = await new Response(stream).text();
        onProgress(1);
    } else {
        text = new TextDecoder("utf-8").decode(buf);
    }
    return JSON.parse(text);
}

/**
 * Parse a binary index file according to the RuneLite plugin hub format.
 * 
 * Binary Index Format:
 * [4 bytes: fileCount (uint32 LE)]
 * [entries:
 *   [2 bytes: fileNameLen (uint16 LE)]
 *   [fileNameLen bytes: fileName]
 *   [2 bytes: pluginNameLen (uint16 LE)]
 *   [pluginNameLen bytes: pluginName]
 *   [4 bytes: stringOffset (uint32 LE)]
 *   [4 bytes: contentLength (uint32 LE)]
 *   [2 bytes: lineCount (uint16 LE)]
 *   [lineCount * 4 bytes: lineOffsets (uint32 LE array)]]
 * [4 bytes: stringTableOffset (uint32 LE)]
 * [stringTable: UTF-8 text from stringTableOffset to end]
 * 
 * @param {ArrayBuffer|Buffer} buffer - The binary index data
 * @param {Object|null} manifest - Optional manifest object for filtering internal plugins
 * @returns {Object} { fileCount, entries: [{fileName, pluginName, stringOffset, contentLength, lineOffsets}] }
 */
function parseBinaryIndex(buffer, manifest = null) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    let p = 0;
    const fileCount = view.getUint32(p, true);
    p += 4;

    const entries = [];
    for (let i = 0; i < fileCount; i++) {
        const fileNameLen = view.getUint16(p, true);
        p += 2;
        const fileName = new TextDecoder().decode(bytes.slice(p, p + fileNameLen));
        p += fileNameLen;

        const pluginNameLen = view.getUint16(p, true);
        p += 2;
        const pluginName = new TextDecoder().decode(bytes.slice(p, p + pluginNameLen));
        p += pluginNameLen;

        if (manifest && manifest.internalName && !manifest.internalName[pluginName]) {
            const strOff = view.getUint32(p, true);
            p += 4;
            const len = view.getUint32(p, true);
            p += 4;
            const lineCnt = view.getUint16(p, true);
            p += 2;
            const lineOff = [];
            for (let j = 0; j < lineCnt; j++) {
                lineOff.push(view.getUint32(p, true));
                p += 4;
            }
            continue;
        }

        const strOff = view.getUint32(p, true);
        p += 4;
        const len = view.getUint32(p, true);
        p += 4;
        const lineCnt = view.getUint16(p, true);
        p += 2;
        const lineOff = [];
        for (let j = 0; j < lineCnt; j++) {
            lineOff.push(view.getUint32(p, true));
            p += 4;
        }
        entries.push({ fileName, pluginName, stringOffset: strOff, contentLength: len, lineOffsets: lineOff });
    }

    const strTableOffset = view.getUint32(bytes.byteLength - 4, true);
    const stringTable = new TextDecoder().decode(bytes.slice(strTableOffset));

    return { fileCount: entries.length, entries, stringTable };
}

export { decodeJson, decodeJsonWithProgress, parseBinaryIndex };
