import { queryIndex, waitForIndex, parseIndex } from "./search-browser.js";
import { getInstallCounts } from "./fetcher.js";
import { SearchComponent } from "./search-component.js";

let InstallCounts = {};

async function runDeprecate() {
    //console.log("[DEBUG] Starting mobile debug: runDeprecate called");
    
    await waitForIndex();
    //console.log("[DEBUG] Index wait completed, setting index ready");
    Search.setIndexReady();

    try {
        InstallCounts = await getInstallCounts();
        //console.log("[DEBUG] Install counts fetched successfully:", Object.keys(InstallCounts).length + " plugins");
    } catch (e) {
        console.error("Failed to fetch install counts:", e);
    }

    // Create entries BEFORE creating the Vue app so Search instances are created with index ready
    let entries;
    //console.log("[DEBUG] Checking URL hash for search parameters");
    let hash = window.location.hash;
    if (hash) {
        //console.log("[DEBUG] Hash found:", hash);
        if (hash.startsWith("#search?str=")) {
            const searchStr = hash.substr("#search?str=".length);
            //console.log("[DEBUG] Creating entry from URL search string");
            entries = [new Search(searchStr)];
        } else if (hash.startsWith("#")) {
            hash = hash.substr(1);
            hash = atob(hash);
            hash = JSON.parse(hash);
            //console.log("[DEBUG] Creating", hash.length, "entries from encoded hash");
            entries = hash.map(v => new Search(v));
        }
    }
    if (!entries) {
        //console.log("[DEBUG] No hash found, creating default entry with 'Toa Keris Cam'");
        entries = [new Search("Toa Keris Cam")];
    }

    //console.log("[DEBUG] Creating Vue app with", entries.length, "entry(s)");
    const app = Vue.createApp({
        data() {
            const indexInfo = parseIndex();
            return {
                fetchError: null,
                entries: entries,
                InstallCounts: InstallCounts,
                lastModified: indexInfo.lastModified,
                isRegex: true,
                caseSensitive: true,
            };
        },

        watch: {
            isRegex(value) {
                Search.setIsRegex(value);
                this.entries.forEach(entry => {
                    if (entry._lastSearchValue && entry._lastSearchValue !== "") {
                        entry.regex = entry._lastSearchValue;
                    }
                });
            },
            caseSensitive(value) {
                Search.setCaseSensitive(value);
                this.entries.forEach(entry => {
                    if (entry._lastSearchValue && entry._lastSearchValue !== "") {
                        entry.regex = entry._lastSearchValue;
                    }
                });
            }
        },
        
        template: `
<div id="app">
    <div class="toolbar">
        <label class="toolbar-item">
            <input type="checkbox" v-model="isRegex">
            Regex
        </label>
        <label class="toolbar-item">
            <input type="checkbox" v-model="caseSensitive">
            Case sensitive
        </label>
    </div>
    <div class="content">
        <Search v-for="entry of entries" :key="entry.id" :entry="entry" :installCounts="InstallCounts"></Search>
    </div>
    <footer class="footer">
      <a href="https://github.com/JZomDev/pluginhub-searcher/commits/main">pluginhub-searcher</a>
      <span v-if="lastModified"> | Last updated: {{ formatDate(lastModified) }}</span>
    </footer></div>`,
        components: {
            Search: SearchComponent,
        },
        created() {
            this.$watch("entries", () => {
                history.replaceState(undefined, undefined, "#" + btoa(JSON.stringify(this.entries.map(s => s.regex))));

                if (this.entries.length === 0 || this.entries[this.entries.length - 1].regex !== "") {    
                    this.entries.push(new Search());
                }
                for (let i = this.entries.length - 2; i >= 0; i--) {
                    if (this.entries[i].regex === "" && !this.entries[i].focused) {
                        this.entries.splice(i, 1);
                    }
                }
            }, {deep: true});
        },
        methods: {
            formatDate(isoString) {
                const date = new Date(isoString);
                const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                const month = months[date.getMonth()];
                const day = date.getDate();
                const year = date.getFullYear();
                let hours = date.getHours();
                const minutes = date.getMinutes();
                const ampm = hours >= 12 ? "PM" : "AM";
                hours = hours % 12;
                hours = hours ? hours : 12;
                const minutesStr = minutes < 10 ? "0" + minutes : minutes;
                return `${month} ${day}, ${year}, ${hours}:${minutesStr} ${ampm}`;
            },
        },
    }).mount("#app");
}

class Search {
    static numEntries = 1;
    static _indexReady = false;
    static _isRegex = true;
    static _caseSensitive = true;

    static setIndexReady() {
        Search._indexReady = true;
    }

    static setIsRegex(value) {
        Search._isRegex = value;
    }

    static setCaseSensitive(value) {
        Search._caseSensitive = value;
    }

    constructor(init) {
        this.id = Search.numEntries++;
        this.searchType = "regex";
        this._regex = init || "";
        this.error = "";
        this.allMatches = [];
        this.symbols = Vue.reactive([]);
        this.focused = false;
        this.tempValue = this._regex;
        this._debounceTimer = null;
        this._lastSearchValue = null;

        if (this._regex !== "") {
            // Clear any existing timer
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

        if (value === "") {
            this.error = "";
            this.allMatches = [];
            this.symbols.length = 0;
            return;
        }

        // Debounce: wait 500ms after user stops typing before searching
        this._debounceTimer = setTimeout(async () => {
            this._lastSearchValue = value;
            await this._performSearch(value);
        }, 500);
    }

    async _performSearch(value, options) {
        this.error = "";
        this.allMatches = [];
        
        try {
            const searchOptions = {
                isRegex: Search._isRegex,
                caseSensitive: Search._caseSensitive,
                ...options
            };
            const results = await queryIndex(value, searchOptions);
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
            // Clear existing reactive array and push new items to maintain reactivity
            this.symbols.length = 0;
            this.symbols.push(...symbols);
        } catch (e) {
            this.error = e.message || e;
            console.error(e);
        }
    }

    // installCounts: {},
};

export { Search };

runDeprecate().catch(e => console.error(e));
