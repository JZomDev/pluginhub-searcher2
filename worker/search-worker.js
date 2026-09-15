import { AutoMap, decodeJson } from "../script/indexer.js";
import { decodeJson as parseJson } from "../script/parser.js";

let indexedUsages = null;

self.onmessage = function(e) {
    const { type, payload } = e.data;

    if (type === 'LOAD_INDEX') {
        loadIndex(payload);
    } else if (type === 'SEARCH') {
        performSearch(payload.query, payload.searchType);
    } else if (type === 'SET_INDEX') {
        indexedUsages = payload.index;
        self.postMessage({ type: 'INDEX_LOADED', count: indexedUsages.size });
    }
};

async function loadIndex(url) {
    try {
        const response = await fetch(url);
        const buf = await response.arrayBuffer();
        indexedUsages = await parseJson(buf);
        self.postMessage({ type: 'INDEX_LOADED', count: indexedUsages.size });
    } catch (error) {
        self.postMessage({ type: 'ERROR', error: error.message });
    }
}

function performSearch(query, searchType = 'regex') {
    if (!indexedUsages) {
        self.postMessage({ type: 'ERROR', error: 'Index not loaded' });
        return;
    }

    const groups = new AutoMap(() => new AutoMap(() => new Set()));
    const symbols = [];
    const allMatches = new Set();
    let error = '';

    try {
        const isLiteral = typeof query === 'string' && !/[\\^$.*+?{}\[\]|()]/.test(query);
        const re = isLiteral ? null : new RegExp(query);

        for (const [fileName, index] of indexedUsages) {
            for (const sym in index) {
                if (!Object.hasOwn(index, sym)) continue;
                const plugins = index[sym];

                let match = isLiteral ? sym.indexOf(query) !== -1 ? [query] : null : re.exec(sym);
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
                            symbols.push({ text: sym, plugin });
                            allMatches.add(plugin.plugin);
                        }
                    }
                    if (!isLiteral && match.groups) {
                        for (let group in match.groups) {
                            let groupMatches = groups.get(group).get(match.groups[group]);
                            for (let plugin of plugins) {
                                groupMatches.add(plugin);
                            }
                        }
                    }
                }
            }
        }

        self.postMessage({
            type: 'SEARCH_RESULT',
            results: {
                symbols,
                allMatches: [...allMatches],
                groups: processGroups(groups),
                error
            }
        });
    } catch (e) {
        self.postMessage({ type: 'ERROR', error: e.message });
    }
}

function processGroups(groups) {
    return [...groups.entries()].map(([name, group]) => {
        group = [...group.entries()].map(([name, plugins]) => {
            return [name, [...plugins]];
        });
        return [name, group];
    });
}
