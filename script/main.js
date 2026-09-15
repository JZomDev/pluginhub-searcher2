import { queryIndex, waitForIndex } from "./search-browser.js";
import { getInstallCounts, getManifest } from "./fetcher.js";

let InstallCounts = {};
let Manifest = {};

async function runDeprecate() {
    await waitForIndex();

    try {
        InstallCounts = await getInstallCounts();
        Manifest = await getManifest();
    } catch (e) {
        console.error("Failed to fetch install counts:", e);
    }
    const app = Vue.createApp({
        data() {
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

            return {
                fetchError: null,
                entries: entries || [new Search("Toa Keris Cam")]
            };
        },
        
        template: `
<div class="content">
    <Search v-for="entry of entries" :key="entry.id" :entry="entry"></Search>
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



// Trigger regex setter on all initial searches to populate results
    for (let entry of app.entries) {
        entry.regex = entry._regex;
    }

}

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
            // Clear any existing timer and wait for index to be ready before searching
            clearTimeout(this._debounceTimer);
            this._lastSearchValue = this._regex;
            this._performSearch(this._regex);
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

        // Debounce: wait 500ms after user stops typing before searching
        this._debounceTimer = setTimeout(async () => {
            this._lastSearchValue = value;
            await this._performSearch(value);
        }, 500);
    }

    async _performSearch(value) {
        this.error = "";
        this.allMatches = [];
        this.symbols = [];

        try {
            const results = await queryIndex(value);
            const symbols = [];

            for (const [fileName, data] of Object.entries(results)) {
                const { matches, pluginName } = data;
                for (const m of matches) {
                    symbols.push({
                        text: fileName,
                        file: fileName,
                        line: m.line,
                        lineText: m.text,
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
                showPlugins: true,
                showLines: false,
            };
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
                        groups[symbol.file] = { pluginName: symbol.plugin, items: [] };
                    }
                    groups[symbol.file].items.push(symbol);
                }
                return groups;
            },
            allSymbols() {
                const list = [...this.entry.symbols];
                list.sort((a, b) => (InstallCounts[b.plugin] || 0) - (InstallCounts[a.plugin] || 0));
                return list;
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
                const list = Object.values(this.groupedPlugins);
                list.sort((a, b) => (InstallCounts[b.pluginName] || 0) - (InstallCounts[a.pluginName] || 0));
                return list;
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
                    clearTimeout(this.entry._debounceTimer);
                    this.entry._debounceTimer = null;
                    this.entry.regex = this.entry.tempValue;
                }
            },
            handleInput(value) {
                this.entry.tempValue = value;
                if (this.entry._debounceTimer) {
                    clearTimeout(this.entry._debounceTimer);
                }
                this.entry._debounceTimer = setTimeout(() => {
                    this.entry.regex = value;
                    this.entry._debounceTimer = null;
                }, 500);
            },
                
            getPluginName(filename) {
                return filename.split('/').pop().replace('.jar', '');
            },
            getInstalls(pluginName) {
                const count = InstallCounts[pluginName];
                return count != null ? + count : 0;
            },
            async openPlugin(pluginName) {
                
                let req = await fetch(`https://raw.githubusercontent.com/runelite/plugin-hub/master/plugins/${pluginName}`);
                let text = await req.text();
                let prop = {};
                for (let line of text.split("\n")) {
                    let kv = line.split("=", 2);
                    if (kv.length == 2) {
                        prop[kv[0]] = kv[1];
                    }
                }
            window.open(`${prop.repository.replace(/\.git$/, "")}/tree/${prop.commit}`);
            }
        },
        template: `
<div class="search">
    <input :value="entry.tempValue"
           @input="handleInput($event.target.value); entry.tempValue=$event.target.value"
           @keydown="handleKeydown"
           @blur="entry.focused=false;"
           placeholder="Toa Keris Cam"
           @focus="entry.focused=true">

    <div v-if="entry.error" class="error">{{entry.error}}</div>
    <div v-if="!entry.error && entry.symbols.length > 0">
        <div class="result-summary">
            <div class="plugin-count" style="cursor: pointer;" @click="showPlugins = !showPlugins">
                {{ showPlugins ? '−' : '+' }} {{pluginCount}} plugins
            </div>
            <div v-if="showPlugins" class="symbol-list">
                <div v-for="plugin in groupedPluginList" :key="plugin.pluginName" class="plugin-entry">
                    <a href @click.prevent="openPlugin(plugin.pluginName)">{{plugin.pluginName}}</a> ({{ getInstalls(plugin.pluginName) }})
                </div>
            </div>
            <div class="line-count" style="cursor: pointer;" @click="showLines = !showLines">
                {{ showLines ? '−' : '+' }} {{lineCount}} lines of text
            </div>
            <div v-if="showLines" class="symbol-list">
                <div v-for="(symbol, index) in allSymbols.slice(0, 5000)" :key="'l' + index" class="line-item">
                    <a href="#" @click.prevent="openLine(symbol)">
                        {{symbol.lineText}} --- {{symbol.plugin}}
                    </a>
                </div>
                <div v-if="allSymbols.length > 5000" class="summary-footer">
                    {{ allSymbols.length }} total results (showing 5000)
                </div>
            </div>
        </div>
    </div>
</div>
`,
    }
}

runDeprecate().catch(e => console.error(e));
