/**
 * Browser-compatible binary index search.
 * Used by script/search-browser.js for in-browser searching.
 * DO NOT modify this module - it is imported by browser UI code.
 */

const GZ_INDEX = "index/plugins.bin.gz";

const STATE = { ready: false, entries: [], stringTable: "", fileCount: 0 };
let _init = null;
let _indexReadyResolver = null;

async function _initOnce() {
    if (STATE.ready) return;
    if (_init) return;
    _init = (async () => {
        const resp = await fetch(GZ_INDEX, { cache: "no-store" });
        const buf = await resp.arrayBuffer();
        const stream = new Response(buf).body.pipeThrough(new DecompressionStream("gzip"));
        const decompressed = await new Response(stream).arrayBuffer();
        _parseBuffer(decompressed);
    })();
    await _init;
}

function waitForIndex() {
    _initOnce()
    if (STATE.ready) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        if (_indexReadyResolver) {
            _indexReadyResolver();
        } else {
            _indexReadyResolver = resolve;
        }
    });
}

function _parseBuffer(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);

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

    // Read the string table offset stored at the end of the buffer
    const strTableOffset = view.getUint32(bytes.byteLength - 4, true);

    const stringTable = new TextDecoder().decode(bytes.slice(strTableOffset));

    STATE.fileCount = fileCount;
    STATE.entries = entries;
    STATE.stringTable = stringTable;
    STATE.ready = true;
    if (_indexReadyResolver) {
        _indexReadyResolver();
        _indexReadyResolver = null;
    }
}

/**
 * Query the binary index for a term.
 * @param {string} query
 * @returns {Object} { fileName: { matches: [{ line: number, text: string }], pluginName: string } }
 */
async function queryIndex(query) {
    await _initOnce();

    const results = {};
    const table = STATE.stringTable;
    for (let i = 0; i < STATE.entries.length; i++) {
        const e = STATE.entries[i];
        const content = table.substring(e.stringOffset, e.stringOffset + e.contentLength);
        const lines = content.split("\n");
        const matching = [];
        for (let j = 0; j < lines.length; j++) {
            if (lines[j].includes(query)) matching.push({ line: j + 1, text: lines[j] });
        }
        if (matching.length > 0) results[e.fileName] = { matches: matching, pluginName: e.pluginName };
    }
    return results;
}

/**
 * Parse and return raw index data.
 * @returns {Object} { fileCount, entries, stringTable }
 */
function parseIndex() {
    return { fileCount: STATE.fileCount, entries: STATE.entries, stringTable: STATE.stringTable };
}

export { queryIndex, parseIndex, waitForIndex };
