import { readFileSync } from "node:fs";

const GZ_INDEX = "plugins/plugins.bin.gz";

const STATE = { ready: false, entries: [], stringTable: "", fileCount: 0 };
let _init, _manifest;

async function _initOnce(gzFilePath, manifestUrl = null) {
    const path = gzFilePath || GZ_INDEX;
    if (STATE.ready) return;
    if (_init) return;
    _init = (async () => {
        if (manifestUrl) {
            try {
                const req = await fetch(manifestUrl);
                const buf = new DataView(await req.arrayBuffer());
                const skip = 4 + buf.getUint32(0);
                const text = new TextDecoder("utf-8").decode(new Uint8Array(buf.buffer.slice(skip)));
                _manifest = JSON.parse(text);
            } catch (e) {
                console.error("Failed to load manifest:", e);
            }
        }
        const gzData = readFileSync(path);
        const { gunzipSync } = await import("node:zlib");
        const buffer = gunzipSync(gzData);
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

            if (_manifest && _manifest.internalName && !_manifest.internalName[pluginName]) {
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

        const strTableOffset = view.getUint32(buffer.byteLength - 4, true);
        const stringTable = new TextDecoder().decode(bytes.slice(strTableOffset));

        STATE.fileCount = entries.length;
        STATE.entries = entries;
        STATE.stringTable = stringTable;
        STATE.stringTableBytes = bytes.slice(strTableOffset);
        STATE.stringTableLength = bytes.byteLength - strTableOffset;
        STATE.ready = true;
    })();
    await _init;
}

async function queryIndex(gzFilePath, query, manifestUrl = null) {
    await _initOnce(gzFilePath, manifestUrl);

    const results = {};
    const table = STATE.stringTable;
    const tableBytes = STATE.stringTableBytes;
    const re = new RegExp(query);
    
    // Prevent memory exhaustion from overly broad regex patterns
    const MAX_TOTAL_MATCHES = 500;
    let totalMatches = 0;
    
    for (let i = 0; i < STATE.entries.length; i++) {
        const e = STATE.entries[i];
        const contentBytes = tableBytes.slice(e.stringOffset, e.stringOffset + e.contentLength);
        const content = new TextDecoder().decode(contentBytes);
        const lines = content.split("\n");
        const matching = [];
        for (let j = 0; j < lines.length; j++) {
            const trimmed = lines[j].trim();
            if (trimmed === '' || trimmed === '{' || trimmed === '}') {
                continue;
            }
            if (re.test(lines[j])) {
                matching.push({ line: j + 1, text: lines[j] });
                totalMatches++;
                // if (totalMatches > MAX_TOTAL_MATCHES) {
                //     throw new Error(`Search results exceed maximum of ${MAX_TOTAL_MATCHES} matches. Please use a more specific search term.`);
                // }
            }
        }
        if (matching.length > 0) results[e.fileName] = { matches: matching, pluginName: e.pluginName };
    }
    return results;
}

function parseIndex() {
    return { fileCount: STATE.fileCount, entries: STATE.entries, stringTable: STATE.stringTable };
}

export { queryIndex, parseIndex, buildTestIndex };

async function buildTestIndex() {}

globalThis.buildTestIndex = buildTestIndex;
