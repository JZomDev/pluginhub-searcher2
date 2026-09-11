let _cachedVersion = null;
async function setVersion(){
    let req = await fetch("https://raw.githubusercontent.com/runelite/plugin-hub/master/runelite.version");
    _cachedVersion = (await req.text()).trim();
}

const root = "https://repo.runelite.net/plugins/"

let _cachedManifest = null;
async function setManifest(){
    let req = await fetch(`${root}manifest/${_cachedVersion}_full.js`);
    let buf = new DataView(await req.arrayBuffer());
    let skip = 4 + buf.getUint32(0);
    let text = new TextDecoder("utf-8").decode(new Uint8Array(buf.buffer.slice(skip)));
    _cachedManifest = JSON.parse(text);
}

let _cachedInstalls = null;
async function setInstalls(){

    let req = await fetch(`https://api.runelite.net/runelite-${_cachedVersion}/pluginhub`);
    _cachedInstalls = await req.json();
}

let _manifestData = null;

async function setManifestData()
{
    _manifestData = await decodeJson(await fetch("docs/manifest.json").then(r => r.arrayBuffer()));
}


// Decode an ArrayBuffer that may be gzip-compressed into a parsed JSON value.
// Detects the gzip magic number (0x1f 0x8b) and decompresses in-browser via
// DecompressionStream only when needed — so this also works transparently if the
// host already applied Content-Encoding: gzip, or if the file is plain JSON.
// Split out from fetchJson so downloading (network) and unzipping (CPU) can be
// tracked as separate loading phases.
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

async function buildIndex(manifest, onProgress = () => {}) {
    const fileIndexes = new Map();
    let lastModified = new Date(0);

    let count = 0;
    const promises = _manifestData.map(async (entry, i) => {
        const url = "docs/" + entry.zipname;
        const response = await fetch(url);
        const buf = await response.arrayBuffer();

        const lastMod = response.headers.get("Last-Modified");
        if (lastMod) {
            const dt = new Date(lastMod);
            if (!isNaN(dt) && dt > lastModified) {
                lastModified = dt;
            }
        }

        const parsedData = await decodeJson(buf);
        fileIndexes.set(entry.zipname, parsedData);
        count++;
        onProgress(count);
    });

    await Promise.all(promises);

    fileIndexes.lastModified = lastModified;
    return fileIndexes;
}

class AutoMap extends Map {
    constructor(factory) {
        super()
        this.factory = factory;
    }
    get(key) {
        let v = super.get(key);
        if (v === undefined) {
            this.set(key, v = this.factory(key));
        }
        return v;
    }
}

(async () => {
    await setVersion();

    await Promise.all([
        setManifest(),
        setInstalls(),
        setManifestData(),
    ]);
    let mf = _cachedManifest;
    let installMap = _cachedInstalls;
    document.body.addEventListener("click", async ev => {
        if (ev?.target?.classList?.contains("plugin")) {
            ev.preventDefault();
            let name = ev.target.dataset.name;
            let req = await fetch(`https://raw.githubusercontent.com/runelite/plugin-hub/master/plugins/${name}`);
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
    });

    const List = {
        props: {
            list: {},
            name: {},
            active: {
                type: Boolean,
                default: false,
            }
        },
        data() {
            return {
                active_: this.active,
            }
        },
        template: `
<div class="list">
	<div class="header" @click="active_=!active_">[ {{active_ ? "-" : "+"}} ] {{list.length}} {{name}}</div>
	<ul v-if="active_">
		<li v-for="(item, idx) of list" :key="idx">
			<slot :item="item"></slot>
		</li>
	</ul>
</div>
`,
    };

    function sortPlugins(plugins) {
        plugins.sort((a, b) => (installMap[b] || 0) - (installMap[a] || 0));
        return plugins;
    }

    class Search {
        static numEntries = 1;
        constructor(init) {
            this.id = Search.numEntries++;
            this.searchType = "regex";
            this._regex = init || "";
            this.error = "";
            this.allMatches = [];
            this.symbols = [];
            this.groups = undefined;
            this.debounceTimer = null;
            this.tempValue = this._regex;
        }

        set regex(value) {
            this._regex = value;
            let error = "";
            let allMatches = new Set();
            // Map<Group, Map<Value, Set<Plugin>>>
            let groups = new AutoMap(() => new AutoMap(() => new Set()));
            let symbols = [];
            if (value != "" && value != "^")
            {
                try {
                    let re = new RegExp(value);
                    // Handle case where app.usages might not be initialized yet
                    let usagesToSearch = app.usages;

                    for (const [fileName, index] of usagesToSearch) {
                        for (const sym in index) {
                            if (!Object.hasOwn(index, sym)) continue;
                            const plugins = index[sym];

                            let match = re.exec(sym);
                            if (match) {
                                let locations = plugins;
                                if (locations.length > 0) {
                                    for (let loc of locations) {
                                        symbols.push({
                                            text: sym,
                                            plugin: loc.plugin,
                                            file: loc.file,
                                            line: loc.line,
                                        });
                                        allMatches.add(loc.plugin);
                                    }
                                } else {
                                    for (let plugin of plugins) {
                                        symbols.push({text: sym, plugin});
                                        allMatches.add(plugin.plugin);
                                    }
                                }
                                if (match.groups) {
                                    for (let group in match.groups) {
                                        let groupMatches = groups.get(group).get(match.groups[group]);
                                        for (let plugin of plugins) {
                                            groupMatches.add(plugin)
                                        }
                                    }
                                }
                            }
                        }
                    }

                } catch (e) {
                    console.error(e);
                    error = e + "";
                }
            }

            this.error = error;
            this.allMatches = sortPlugins([...allMatches]);
            this.symbols = symbols
            if (groups.size > 0) {
                groups = [...groups.entries()].map(([name, group]) => {
                    group = [...group.entries()].map(([name, plugins]) => {
                        plugins = sortPlugins([...plugins]);
                        return [name, plugins];
                    })
                    group.sort(([, a], [, b]) => b.length - a.length)
                    return [name, group];
                });
                groups.sort(([, a], [, b]) => b.length - a.length);
                this.groups = groups;
            } else {
                this.groups = undefined;
            }
        }
        get regex() {
            return this._regex;
        }

        static component = {
            props: ["entry"],
            components: {List},
            methods: {
                getInstalls(name) {
                    return installMap[name] || "";
                },
                handleInput(value) {
                    this.entry.tempValue = value;
                    if (this.entry.debounceTimer) {
                        clearTimeout(this.entry.debounceTimer);
                    }
                    this.entry.debounceTimer = setTimeout(() => {
                        this.entry.regex = value;
                        this.entry.debounceTimer = null;
                    }, 500);
                },
                handleKeydown(event) {
                    if (event.key === "Enter") {
                        if (this.entry.debounceTimer) {
                            clearTimeout(this.entry.debounceTimer);
                            this.entry.debounceTimer = null;
                        }
                        this.entry.regex = this.entry.tempValue;
                    }
                },
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
                }
            },
            template: `
<div class="search">
	<input :value="entry.tempValue" @input="handleInput($event.target.value)" @keydown="handleKeydown" placeholder="Toa Keris Cam" @focus="entry.focused=true" @blur="entry.focused=false">
	<div v-if="entry.error" class="error">{{entry.error}}</div>
	<div v-if="!entry.error">
		<List v-if="entry.groups" v-for="grouping of entry.groups" :list="grouping[1]" :name="'groups by ' + grouping[0]" :active="true" v-slot="{item}">
			<List :list="item[1]" :name="item[0]" v-slot="{item}">
				<span class="plugin" :data-name="item">{{item}} <span class="noselect">({{getInstalls(item)}})</span></span>
			</List>
		</List>
		<List :list="entry.allMatches" :active="!entry.groups" name="plugins" v-slot="{item}">
			<span class="plugin" :data-name="item">{{item}} <span class="noselect">({{getInstalls(item)}})</span></span>
		</List>
			<List :list="entry.symbols" name="lines of text" v-slot="{item}">
				<a href="#" @click.prevent="openLine(item)"><code>{{item.text}}</code></a>
				--- <span class="plugin" :data-name="item.plugin">{{item.plugin}} ({{getInstalls(item.plugin)}})</span>
			</List>
	</div>
</div>
`,
        }
    }

    const app = Vue.createApp({
        data() {
            let entries;
            try {
                let hash = window.location.hash;
                if (hash)
                {
                    if (hash.startsWith("#search?str="))
                    {
                        entries = [new Search(hash.substr("#search?str=".length))];
                    }
                    else if (hash.startsWith("#"))
                    {
                        hash = hash.substr(1);
                        hash = atob(hash);
                        hash = JSON.parse(hash);
                        entries = hash.map(v => new Search(v));
                    }
                }
            } catch (e) {
                console.log("loading hash:", e);
            }
            return {
                entries: entries || [new Search("Toa Keris Cam")],
                lastUpdated: "Loading...",
                usages: [],
                progress: {
                    phase: "fetch",
                    current: 0,
                    total: 0,
                    indexing: true
                }
            }
        },
        template: `
<div class="content">
	<div v-if="progress.indexing">
		{{ progressLabel }}: {{ progress.current }}/{{ progress.total }}
	</div>
	<Search v-for="entry of entries" :key="entry.id" :entry="entry"></Search>
</div>
<footer class="footer">
  <a href="https://github.com/JZomDev/pluginhub-searcher/commits/main">Last updated {{lastUpdated}}</a>
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
        },
        watch: {
        },
        computed: {
            progressLabel() {
                switch (this.progress.phase) {
                    case "fetch": return "Downloading plugin data (files)";
                    case "unzip": return "Decompressing plugin data (files)";
                    case "index": return "Building search index (plugins)";
                    default: return "Loading";
                }
            },
        },
        methods: {
        },
    }).mount("#app");

    // Phase 3 (index): build the searchable regex map from the decompressed content.
    app.progress.phase = "index";
    app.progress.current = 0;
    app.progress.total = _manifestData.length;
    const sd2 = new Date();
    let indexedUsages = await buildIndex(mf, (count) => {
        app.progress.current = count;
    });
    app.usages = indexedUsages;
    const differenceInMs = new Date() - sd2;
    console.log(`Indexed ${indexedUsages.length} symbols from ${mf.jars.length} plugins in ${differenceInMs}ms`);
    app.progress.phase = "done";
    app.progress.indexing = false;

    // Trigger regex setter on all initial searches to populate results
    for (let entry of app.entries) {
        entry.regex = entry._regex;
    }

    if (app.usages.lastModified) {
        app.lastUpdated = app.usages.lastModified.toLocaleString(undefined, {
            year: "numeric",
            month: "short",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
        });
    } else {
        app.lastUpdated = "Unknown";
    }
})().catch(e => console.error(e));