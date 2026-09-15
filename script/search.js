import { readFileSync } from "node:fs";

const GZ_INDEX = "index/plugins.bin.gz";

const STATE = { ready: false, entries: [], stringTable: "", fileCount: 0 };
let _init = null;

async function _initOnce(gzFilePath) {
    const path = gzFilePath || GZ_INDEX;
    if (STATE.ready) return;
    if (_init) return;
    _init = (async () => {
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

        STATE.fileCount = fileCount;
        STATE.entries = entries;
        STATE.stringTable = stringTable;
        STATE.ready = true;
    })();
    await _init;
}

async function queryIndex(gzFilePath, query) {
    await _initOnce(gzFilePath);

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

function parseIndex() {
    return { fileCount: STATE.fileCount, entries: STATE.entries, stringTable: STATE.stringTable };
}

export { queryIndex, parseIndex };
