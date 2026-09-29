const INDEX_JSON = "plugins/plugins.bin.gz.index.json";

const STATE = { ready: false, entries: [], stringTable: "", fileCount: 0, lastModified: null };
let _init = null;
let _indexReadyResolver = null;
const textDecoder = new TextDecoder();

async function _initOnce() {
    //console.log("[BROWSER-DEBUG] _initOnce called, STATE.ready:", STATE.ready);
    if (STATE.ready) return;
    if (_init) return;
    _init = (async () => {
        //console.log("[BROWSER-DEBUG] Fetching index JSON from", INDEX_JSON);
        // Fetch index JSON to get split chunks and lastModified
        const indexResp = await fetch(INDEX_JSON);
        if (!indexResp.ok) {
            console.error("[BROWSER-DEBUG] Failed to fetch index JSON:", indexResp.status, indexResp.statusText);
            throw new Error(`Failed to load index JSON: ${indexResp.status} ${indexResp.statusText}`);
        }
        const indexData = await indexResp.json();
        STATE.lastModified = indexData.lastModified;
        //console.log("[BROWSER-DEBUG] Index JSON loaded, lastModified:", STATE.lastModified, "splits count:", indexData.splits.length);
        
        // Fetch all chunk files in parallel using Promise.all
        const sortedChunks = indexData.splits.sort((a, b) => a.index - b.index);
        //console.log("[BROWSER-DEBUG] Fetching", sortedChunks.length, "chunk files");
        const fetchPromises = sortedChunks.map(async (chunk) => {
            const chunkUrl = `plugins/${chunk.file}`;
            //console.log("[BROWSER-DEBUG] Fetching chunk:", chunkUrl);
            const chunkResp = await fetch(chunkUrl);
            if (!chunkResp.ok) {
                console.error("[BROWSER-DEBUG] Failed to fetch chunk:", chunkUrl, chunkResp.status, chunkResp.statusText);
                throw new Error(`Failed to load chunk ${chunk.file}: ${chunkResp.status} ${chunkResp.statusText}`);
            }
            const buf = await chunkResp.arrayBuffer();
            //console.log("[BROWSER-DEBUG] Chunk loaded:", chunkUrl, "size:", buf.byteLength);
            return { index: chunk.index, buffer: buf };
        });
        
        //console.log("[BROWSER-DEBUG] Waiting for all chunks to load...");
        const results = await Promise.all(fetchPromises);
        const buffers = results.sort((a, b) => a.index - b.index).map(r => r.buffer);
        
        // Concatenate all chunks into single buffer
        const totalSize = buffers.reduce((sum, b) => sum + b.byteLength, 0);
        //console.log("[BROWSER-DEBUG] All chunks loaded, concatenating", buffers.length, "buffers to size:", totalSize);
        const concatenated = new Uint8Array(totalSize);
        let offset = 0;
        for (const buf of buffers) {
            concatenated.set(new Uint8Array(buf), offset);
            offset += buf.byteLength;
        }
        
        // Decompress and parse
        //console.log("[BROWSER-DEBUG] Starting decompression...");
        const stream = new Response(concatenated.buffer).body.pipeThrough(new DecompressionStream("gzip"));
        const decompressed = await new Response(stream).arrayBuffer();
        //console.log("[BROWSER-DEBUG] Decompression complete, size:", decompressed.byteLength);
        //console.log("[BROWSER-DEBUG] About to call _parseBuffer...");
        try {
            _parseBuffer(decompressed);
            //console.log("[BROWSER-DEBUG] _parseBuffer returned successfully");
        } catch (e) {
            console.error("[BROWSER-DEBUG] _parseBuffer threw error:", e.message, e.stack);
        }

        STATE.ready = true;
        if (_indexReadyResolver) {
            _indexReadyResolver();
            _indexReadyResolver = null;
        }
        //console.log("[BROWSER-DEBUG] Index initialization complete");
    })();
    await _init;
}

function waitForIndex() {
    _initOnce();
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
    //console.log("[BROWSER-DEBUG] _parseBuffer called with buffer size:", buffer.byteLength);
    try {
        const bytes = new Uint8Array(buffer);
        const view = new DataView(buffer);

        let p = 0;
        const fileCount = view.getUint32(p, true);
        p += 4;

        //console.log("[BROWSER-DEBUG] Parsing", fileCount, "entries...");
        const entries = [];
        for (let i = 0; i < fileCount; i++) {
            if (i % 100 === 0) {
                //console.log("[BROWSER-DEBUG] Parsed", i, "/", fileCount, "entries so far...");
            }
            const fileNameLen = view.getUint16(p, true);
            p += 2;
            const fileName = textDecoder.decode(bytes.slice(p, p + fileNameLen));
            p += fileNameLen;

            const pluginNameLen = view.getUint16(p, true);
            p += 2;
            const pluginName = textDecoder.decode(bytes.slice(p, p + pluginNameLen));
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
            entries.push({fileName, pluginName, stringOffset: strOff, contentLength: len, lineOffsets: lineOff});
        }
        //console.log("[BROWSER-DEBUG] All", fileCount, "entries parsed successfully");

        const strTableOffset = view.getUint32(bytes.byteLength - 4, true);
        //console.log("[BROWSER-DEBUG] String table offset:", strTableOffset, "from end of buffer");
        const stringTable = textDecoder.decode(bytes.slice(strTableOffset));

        //console.log("[BROWSER-DEBUG] Setting state properties...");
        STATE.fileCount = fileCount;
        STATE.entries = entries;
        STATE.stringTable = stringTable;
        STATE.stringTableBytes = bytes.slice(strTableOffset);
        STATE.stringTableLength = bytes.byteLength - strTableOffset;
        //console.log("[BROWSER-DEBUG] State properties set, marking ready...");
        STATE.ready = true;
        if (_indexReadyResolver) {
            _indexReadyResolver();
            _indexReadyResolver = null;
        }
        //console.log("[BROWSER-DEBUG] Index initialization complete");
    } catch (e) {
        console.error("[BROWSER-DEBUG] Error in _parseBuffer:", e.message, e.stack);
        throw e;
    }
}

async function queryIndex(query, options = {}) {
    await _initOnce();

    //console.log("[QUERY] Searching for:", query, "options:", options);
    
    const results = {};
    const tableBytes = STATE.stringTableBytes;
    const isRegex = options.isRegex !== false;
    const caseSensitive = !!options.caseSensitive;

    let re;
    if (isRegex) {
        re = new RegExp(query, caseSensitive ? undefined : 'i');
    } else {
        const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        re = new RegExp(escapedQuery, caseSensitive ? undefined : 'i');
    }

    //console.log("[QUERY] Regex pattern:", re.source, "flags:", re.flags);

    const MAX_TOTAL_MATCHES = 5000;
    let totalMatches = 0;

    for (let i = 0; i < STATE.entries.length; i++) {
        const e = STATE.entries[i];
        const contentBytes = tableBytes.slice(e.stringOffset, e.stringOffset + e.contentLength);
        const content = textDecoder.decode(contentBytes);
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
            }
        }
        if (matching.length > 0) results[e.fileName] = { matches: matching, pluginName: e.pluginName };
    }
    
    const uniqueCounts = [...new Set(Object.values(results).map(x => x.pluginName))].length;
    //console.log("[QUERY] Found", totalMatches, "matches across", uniqueCounts, "plugins");

    if (totalMatches > MAX_TOTAL_MATCHES) {
        throw new Error(`Found ${totalMatches} line matches across ${uniqueCounts} plugins and it exceeds maximum of ${MAX_TOTAL_MATCHES} line matches. Please use a more specific search term.`);
    }
    return results;
}

function parseIndex() {
    return { fileCount: STATE.fileCount, entries: STATE.entries, stringTable: STATE.stringTable, lastModified: STATE.lastModified };
}

export { queryIndex, waitForIndex, parseIndex };
