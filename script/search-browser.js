const GZ_INDEX = "index/plugins.bin.gz";

const STATE = { ready: false, entries: [], stringTable: "", fileCount: 0 };
let _init = null;
let _indexReadyResolver = null;
let _worker = null;
let _workerReady = false;
let _workerInitPromise = null;

function createWorker() {
    const workerCode = `
        let indexedUsages = null;
        let stringTable = "";
        let entries = [];

        self.onmessage = function(e) {
            const { type, payload } = e.data;

            if (type === 'SET_INDEX') {
                indexedUsages = payload.indexedUsages;
                stringTable = payload.stringTable;
                entries = payload.entries;
                self.postMessage({ type: 'INDEX_LOADED', count: entries.length });
            } else if (type === 'SEARCH') {
                performSearch(payload.query, payload.searchType);
            }
        };

        function performSearch(query, searchType) {
            if (!entries || entries.length === 0) {
                self.postMessage({ type: 'ERROR', error: 'Index not loaded' });
                return;
            }

            try {
                const re = new RegExp(query);
                const results = {};
                
                // Prevent memory exhaustion from overly broad regex patterns
                const MAX_TOTAL_MATCHES = 50000;
                let totalMatches = 0;

                for (let i = 0; i < entries.length; i++) {
                    const e = entries[i];
                    const content = stringTable.substring(e.stringOffset, e.stringOffset + e.contentLength);
                    const lines = content.split("\n");
                    const matching = [];
                    for (let j = 0; j < lines.length; j++) {
                        const line = lines[j];
                        const trimmed = line.trim();
                        if (trimmed === '' || trimmed === '{' || trimmed === '}') {
                            continue;
                        }
                        if (re.test(line)) {
                            matching.push({ line: j + 1, text: line });
                            totalMatches++;
                            // if (totalMatches > MAX_TOTAL_MATCHES) {
                            //     throw new Error('Search results exceed maximum of ' + MAX_TOTAL_MATCHES + ' matches. Please use a more specific search term.');
                            // }
                        }
                    }
                    if (matching.length > 0) {
                        results[e.fileName] = { matches: matching, pluginName: e.pluginName };
                    }
                }

                self.postMessage({
                    type: 'SEARCH_RESULT',
                    results: results
                });
            } catch (error) {
                self.postMessage({ type: 'ERROR', error: error.message });
            }
        }
    `;

    const blob = new Blob([workerCode], { type: 'application/javascript' });
    return new Worker(URL.createObjectURL(blob));
}

async function _initOnce() {
    if (STATE.ready) return;
    if (_init) return;
    _init = (async () => {
        const resp = await fetch(GZ_INDEX, { cache: "no-store" });
        const buf = await resp.arrayBuffer();
        const stream = new Response(buf).body.pipeThrough(new DecompressionStream("gzip"));
        const decompressed = await new Response(stream).arrayBuffer();
        _parseBuffer(decompressed);
        
        _worker = createWorker();
        _worker.onmessage = function(e) {
            const { type, payload } = e.data;
            if (type === 'INDEX_LOADED') {
                _workerReady = true;
                if (_indexReadyResolver) {
                    _indexReadyResolver();
                    _indexReadyResolver = null;
                }
            } else if (type === 'ERROR') {
                console.error('Worker error:', payload.error);
            }
        };
        _worker.onerror = function(e) {
            console.error('Worker error event:', e);
        };
    })();
    await _init;
}

function waitForIndex() {
    _initOnce()
    if (STATE.ready && _workerReady) {
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

async function queryIndex(query) {
    await _initOnce();

    if (!_worker || !_workerReady) {
        const results = {};
        const table = STATE.stringTable;
        const re = new RegExp(query);
        
        // Prevent memory exhaustion from overly broad regex patterns
        const MAX_TOTAL_MATCHES = 5000;
        let totalMatches = 0;
        
        for (let i = 0; i < STATE.entries.length; i++) {
            const e = STATE.entries[i];
            const content = table.substring(e.stringOffset, e.stringOffset + e.contentLength);
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
        let uniqueCounts = [...new Set(Object.values(results).map(x => x.pluginName))].length 
    
        if (totalMatches > MAX_TOTAL_MATCHES) {
            throw new Error(`Found ${totalMatches} line matches across ${uniqueCounts} plugins and it exceeds maximum of ${MAX_TOTAL_MATCHES} line matches. Please use a more specific search term.`);
        }
        return results;
    }

    return new Promise((resolve, reject) => {
        const handler = function(e) {
            const { type, payload } = e.data;
            if (type === 'SEARCH_RESULT') {
                _worker.removeEventListener('message', handler);
                resolve(payload.results);
            } else if (type === 'ERROR') {
                _worker.removeEventListener('message', handler);
                reject(new Error(payload.error));
            }
        };
        _worker.addEventListener('message', handler);
        _worker.postMessage({ type: 'SEARCH', payload: { query, searchType: 'regex' } });
    });
}

function parseIndex() {
    return { fileCount: STATE.fileCount, entries: STATE.entries, stringTable: STATE.stringTable };
}

export { queryIndex, parseIndex, waitForIndex };
