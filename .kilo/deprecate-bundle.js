// Auto-generated bundle from script modules
// Do not edit manually

const root = "https://repo.runelite.net/plugins/";

class Fetcher {
    constructor() {
        this._cachedVersion = null;
        this._cachedManifest = null;
        this._cachedInstalls = null;
    }

    async getRuneliteVersion() {
        if (this._cachedVersion) {
            return this._cachedVersion;
        }
        const req = await fetch("https://raw.githubusercontent.com/runelite/plugin-hub/master/runelite.version");
        this._cachedVersion = (await req.text()).trim();
        return this._cachedVersion;
    }

    async getManifest(version) {
        if (this._cachedManifest) {
            return this._cachedManifest;
        }
        const req = await fetch(`${root}manifest/${version}_full.js`);
        const buf = new DataView(await req.arrayBuffer());
        const skip = 4 + buf.getUint32(0);
        const text = new TextDecoder("utf-8").decode(new Uint8Array(buf.buffer.slice(skip)));
        this._cachedManifest = JSON.parse(text);
        return this._cachedManifest;
    }

    async getInstallCounts(version) {
        if (this._cachedInstalls) {
            return this._cachedInstalls;
        }
        const req = await fetch(`https://api.runelite.net/runelite-${version}/pluginhub`);
        this._cachedInstalls = await req.json();
        return this._cachedInstalls;
    }

    async fetchArchive(url, onProgress = () => {}) {
        const response = await fetch(url);
        const buf = await response.arrayBuffer();
        onProgress(1);
        return { buf, lastModified: response.headers.get("Last-Modified") };
    }
}



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



import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

// ---- Node.js / CLI version ----

function parseBinaryIndex(gzFilePath) {
    const gzData = readFileSync(gzFilePath);
    const buffer = gzipSync(gzData);

    const entries = [];
    let pos = 0;
    const fileCount = buffer.readUInt32LE(pos);
    pos += 4;

    for (let i = 0; i < fileCount; i++) {
        const fileNameLength = buffer.readUInt16LE(pos);
        pos += 2;
        const fileName = buffer.toString("utf8", pos, pos + fileNameLength);
        pos += fileNameLength;
        const stringOffset = buffer.readUInt32LE(pos);
        pos += 4;
        const contentLength = buffer.readUInt32LE(pos);
        pos += 4;
        const lineOffsetCount = buffer.readUInt16LE(pos);
        pos += 2;
        const lineOffsets = [];
        for (let j = 0; j < lineOffsetCount; j++) {
            lineOffsets.push(buffer.readUInt16LE(pos));
            pos += 2;
        }
        entries.push({
            fileName,
            stringOffset,
            contentLength,
            lineOffsets
        });
    }

    const stringTableOffset = buffer.readUInt32LE(pos);
    const stringTable = buffer.toString("utf8", stringTableOffset);

    return { fileCount, entries, stringTableOffset, stringTable, buffer };
}

function buildSearcher(gzFilePath) {
    const { fileCount, entries, stringTable } = parseBinaryIndex(gzFilePath);
    return {
        search(query) {
            const results = {};
            for (let i = 0; i < fileCount; i++) {
                const entry = entries[i];
                const content = stringTable.substring(entry.stringOffset, entry.stringOffset + entry.contentLength);
                const lines = content.split("\n");
                const matchingLines = [];
                for (let j = 0; j < lines.length; j++) {
                    if (lines[j].includes(query)) matchingLines.push(j + 1);
                }
                if (matchingLines.length > 0) results[entry.fileName] = matchingLines;
            }
            return results;
        },
        getRawData() {
            return { fileCount, entries };
        }
    };
}

function searchIndex(gzFilePath) {
    return buildSearcher(gzFilePath);
}

export { buildSearcher, parseBinaryIndex, searchIndex };

import { queryIndex } from "./search-browser.js";

let _cachedVersion = null;
let _cachedInstalls = null;

async function fetchPluginInstalls() {
    if (_cachedInstalls) return _cachedInstalls;

    if (!_cachedVersion) {
        const req = await fetch("https://raw.githubusercontent.com/runelite/plugin-hub/master/runelite.version");
        _cachedVersion = (await req.text()).trim();
    }

    const req = await fetch(`https://api.runelite.net/runelite-${_cachedVersion}/pluginhub`);
    _cachedInstalls = await req.json();
    return _cachedInstalls;
}

async function runDeprecate() {
    let entries;

    let hash = window.location.hash;
    if (hash) {
        if (hash.startsWith("#search?str=")) {
            entries = [new Search(hash.substr("#search?str=".length))];
        } else if (hash.startsWith("#")) {
            hash = hash.substr(1);
            hash = atob(hash);
            hash = JSON.parse(hash);
            entries = hash.map(v => new Search(v));
        }
    }

    const app = Vue.createApp({
        data() {
            return {
                entries: entries || [new Search("RunePouch")],
            };
        },
        template: `
<div class="content">
    <Search v-for="entry of entries" :key="entry.id" :entry="entry"></Search>
    <div v-if="entries.length === 0" class="prompt">
        Type to search plugin source files...
    </div>
</div>
<footer class="footer">
  <a href="https://github.com/JZomDev/pluginhub-searcher/commits/main">pluginhub-searcher</a>
</footer>`,
        components: {
            Search: Search.component,
        },
        created() {
            this.$watch("entries", () => {
                history.replaceState(undefined, undefined, "#" + btoa(JSON.stringify(this.entries.map(s => s.regex))));

                if (this.entries.length == 0 || this.entries[this.entries.length - 1].regex != "") {
                    this.entries.push(new Search());
                }
                for (let i = this.entries.length - 2; i >= 0; i--) {
                    if (this.entries[i].regex == "" && !this.entries[i].focused) {
                        this.entries.splice(i, 1);
                    }
                }
            }, {deep: true});
        }
    }).mount("#app");
}

let _installCounts = {};
const InstallCounts = (n) => _installCounts[n];

class Search {
    static numEntries = 1;

    constructor(init) {
        this.id = Search.numEntries++;
        this.searchType = "literal";
        this._regex = init || "";
        this.error = "";
        this.allMatches = [];
        this.symbols = Vue.reactive([]);
        this.focused = false;
        this.tempValue = this._regex;
        this._debounceTimer = null;
        this._lastSearchValue = null;

        if (this._regex !== "") {
            this._doSearch(this._regex);
        }
    }

    set regex(value) {
        this._regex = value;
        this._doSearch(value);
    }
    get regex() {
        return this._regex;
    }

    async _doSearch(value) {
        clearTimeout(this._debounceTimer);

        if (value === "" || value === "^") {
            this.error = "";
            this.allMatches = [];
            this.symbols = [];
            return;
        }

        // Search immediately for new values, debounce for re-searches of same value
        if (this._lastSearchValue !== value) {
            this._lastSearchValue = value;
            await this._performSearch(value);
        } else {
            this._debounceTimer = setTimeout(async () => {
                await this._performSearch(value);
            }, 500);
        }
    }

    async _performSearch(value) {
        this.error = "";
        this.allMatches = [];
        this.symbols = [];

        try {
            const results = await queryIndex(value);
            const symbols = [];

            for (const [fileName, data] of Object.entries(results)) {
                const { lines, pluginName } = data;
                for (const line of lines) {
                    symbols.push({
                        text: fileName,
                        file: fileName,
                        line: line,
                        plugin: pluginName,
                    });
                }
            }

            this.allMatches = [];
            this.symbols = symbols;
        } catch (e) {
            this.error = e + "";
            console.error(e);
        }
    }

    static component = {
        props: ["entry"],
        data() {
            return {
                showPlugins: false,
                showLines: false,
            };
        },
        async mounted() {
            _installCounts = await fetchPluginInstalls();
        },
        computed: {
            pluginCount() {
                const plugins = new Set(this.entry.symbols.map(s => s.plugin));
                return plugins.size;
            },
            lineCount() {
                return this.entry.symbols.length;
            },
            groupedSymbols() {
                const groups = {};
                for (const symbol of this.entry.symbols) {
                    if (!groups[symbol.file]) {
                        groups[symbol.file] = [];
                    }
                    groups[symbol.file].push(symbol);
                }
                return groups;
            },
            allSymbols() {
                return this.entry.symbols;
            },
            groupedPlugins() {
                const groups = {};
                for (const symbol of this.entry.symbols) {
                    const p = symbol.plugin;
                    if (!groups[p]) {
                        groups[p] = { pluginName: p, count: 0 };
                    }
                    groups[p].count++;
                }
                return groups;
            },
            groupedPluginList() {
                return Object.values(this.groupedPlugins);
            },
        },
        methods: {
            async openLine(item) {
                try {
                    let req = await fetch(`https://raw.githubusercontent.com/runelite/plugin-hub/master/plugins/${item.plugin}`);
                    let text = await req.text();
                    let prop = {};
                    for (let line of text.split("\n")) {
                        let kv = line.split("=", 2);
                        if (kv.length == 2) prop[kv[0]] = kv[1];
                    }
                    const repo = (prop.repository || "").replace(/\.git$/, "");
                    const commit = prop.commit || "";
                    if (item && item.file) {
                        const safeFile = item.file.replace(/^\/+/, "");
                        const lineNumber = item.line || 1;
                        window.open(`${repo}/tree/${commit}/${safeFile}#L${lineNumber}`);
                    } else {
                        window.open(`${repo}/tree/${commit}`);
                    }
                } catch (e) {
                    console.error(e);
                }
            },
            handleKeydown(event) {
                if (event.key === "Enter") {
                    if (this.entry.debounceTimer) {
                        clearTimeout(this.entry._debounceTimer);
                        this.entry._debounceTimer = null;
                    }
                    this.entry.regex = this.entry.tempValue;
                }
            },
            getPluginName(filename) {
                return filename.split('/').pop().replace('.jar', '');
            },
            getInstalls(name) {
                return InstallCounts(name) || "";
            },
        },
        template: `
<div class="search">
    <input :value="entry.tempValue"
           @input="entry._doSearch($event.target.value); entry.tempValue=$event.target.value"
           @keydown="handleKeydown"
           placeholder="RunePouch"
           @focus="entry.focused=true" @blur="entry.focused=false">
    <div v-if="entry.allMatches.length === 0 && entry.symbols.length === 0 && entry.tempValue.length !== 0" class="empty">
        No results
    </div>
    <div v-if="entry.error" class="error">{{entry.error}}</div>
    <div v-if="!entry.error && entry.symbols.length > 0">
        <div class="result-summary">
            <div class="search-header">Searched: {{entry.tempValue}}</div>
            <div class="plugin-count" style="cursor: pointer;" @click="showPlugins = !showPlugins">
                {{ showPlugins ? '−' : '+' }} {{pluginCount}} plugins
            </div>
            <div v-if="showPlugins" class="symbol-list">
                <div v-for="plugin in groupedPluginList" :key="plugin.pluginName" class="plugin-entry">
                    {{plugin.pluginName}} --- ({{ getInstalls(plugin.pluginName) }})
                </div>
            </div>
            <div class="line-count" style="cursor: pointer;" @click="showLines = !showLines">
                {{ showLines ? '−' : '+' }} {{lineCount}} lines of text
            </div>
            <div v-if="showLines" class="symbol-list">
                <div v-for="(symbol, index) in allSymbols.slice(0, 15)" :key="'l' + index" class="line-item">
                    <a href="#" @click.prevent="openLine(symbol)">
                        {{symbol.file}}:{{symbol.line}} --- {{symbol.plugin}}
                    </a>
                </div>
                <div v-if="allSymbols.length > 15" class="summary-footer">
                    {{ allSymbols.length }} total results (showing 15)
                </div>
            </div>
        </div>
    </div>
</div>
`,
    }
}

runDeprecate().catch(e => console.error(e));
