(function () {
    'use strict';

    const INDEX_URL = new URL('plugins/index/', document.baseURI);
    const MAX_RESULTS = 5000;
    const entriesElement = document.getElementById('entries');
    const regexElement = document.getElementById('regex');
    const caseSensitiveElement = document.getElementById('case-sensitive');
    const updatedElement = document.getElementById('index-updated');
    let searcher;
    let installCounts = {};
    let isRegex = regexElement.checked;
    let caseSensitive = caseSensitiveElement.checked;
    let nextEntryId = 1;

    function repositoryUrl(repository, suffix = '') {
        if (!repository) return null;
        try {
            const url = new URL(repository.replace(/\.git$/i, ''));
            if (url.protocol !== 'https:') return null;
            url.search = '';
            url.hash = '';
            url.pathname = `${url.pathname.replace(/\/+$/, '')}${suffix}`;
            return url.href;
        } catch {
            return null;
        }
    }

    function sourceUrl(result) {
        if (!result.commit || !result.filePath) return null;
        const safePath = result.filePath.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
        const url = repositoryUrl(result.repository, `/tree/${encodeURIComponent(result.commit)}/${safePath}`);
        if (!url) return null;
        const permalink = new URL(url);
        permalink.hash = `L${result.line}`;
        return permalink.href;
    }

    async function loadInstallCounts() {
        const versionResponse = await fetch('https://raw.githubusercontent.com/runelite/plugin-hub/master/runelite.version');
        if (!versionResponse.ok) throw new Error(`Could not load RuneLite version: HTTP ${versionResponse.status}`);
        const version = (await versionResponse.text()).trim();
        if (!/^\d+(?:\.\d+)+$/.test(version)) throw new Error('Invalid RuneLite version');
        const response = await fetch(`https://api.runelite.net/runelite-${version}/pluginhub`);
        if (!response.ok) throw new Error(`Could not load plugin install counts: HTTP ${response.status}`);
        const counts = await response.json();
        if (!counts || typeof counts !== 'object' || Array.isArray(counts)) throw new Error('Invalid plugin install-count data');
        return counts;
    }

    function saveQueries() {
        const values = [...entriesElement.querySelectorAll('.search-input')].map(input => input.value);
        history.replaceState(undefined, '', `#${btoa(unescape(encodeURIComponent(JSON.stringify(values))))}`);
    }

    function createEntry(initialQuery = '') {
        const id = nextEntryId++;
        const container = document.createElement('section');
        container.className = 'search';
        container.dataset.entryId = id;

        const input = document.createElement('input');
        input.className = 'search-input';
        input.type = 'text';
        input.placeholder = 'Toa Keris Cam';
        input.value = initialQuery;
        input.setAttribute('aria-label', 'Search source code');

        const error = document.createElement('div');
        error.className = 'error';
        error.hidden = true;

        const summary = document.createElement('div');
        summary.className = 'result-summary';
        summary.hidden = true;

        const pluginCount = document.createElement('div');
        pluginCount.className = 'plugin-count noselect';
        pluginCount.tabIndex = 0;
        pluginCount.setAttribute('role', 'button');
        pluginCount.setAttribute('aria-expanded', 'true');

        const pluginList = document.createElement('div');
        pluginList.className = 'symbol-list plugin-list';

        const lineCount = document.createElement('div');
        lineCount.className = 'line-count noselect';
        lineCount.tabIndex = 0;
        lineCount.setAttribute('role', 'button');
        lineCount.setAttribute('aria-expanded', 'false');

        const lineList = document.createElement('div');
        lineList.className = 'symbol-list line-list';
        lineList.hidden = true;

        summary.append(pluginCount, pluginList, lineCount, lineList);
        container.append(input, error, summary);
        entriesElement.append(container);

        const entry = {
            id,
            container,
            input,
            error,
            summary,
            pluginCount,
            pluginList,
            lineCount,
            lineList,
            timer: null,
            request: 0,
            results: []
        };
        container._searchEntry = entry;

        const search = () => {
            clearTimeout(entry.timer);
            entry.timer = null;
            if (input.value.trim()) performSearch(entry);
            saveQueries();
        };

        input.addEventListener('input', () => {
            clearTimeout(entry.timer);
            if (!input.value.trim()) {
                if (entry.container !== entriesElement.lastElementChild) {
                    entry.container.remove();
                } else {
                    entry.results = [];
                    renderEntry(entry);
                }
                saveQueries();
                return;
            }
            if (entry.container === entriesElement.lastElementChild) createEntry('');
            entry.timer = setTimeout(search, 500);
        });
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') search();
        });
        input.addEventListener('blur', saveQueries);
        pluginCount.addEventListener('click', () => toggleDisclosure(entry, 'plugins'));
        pluginCount.addEventListener('keydown', event => disclosureKeydown(event, entry, 'plugins'));
        lineCount.addEventListener('click', () => toggleDisclosure(entry, 'lines'));
        lineCount.addEventListener('keydown', event => disclosureKeydown(event, entry, 'lines'));

        if (initialQuery) performSearch(entry);
        return entry;
    }

    function disclosureKeydown(event, entry, type) {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleDisclosure(entry, type);
        }
    }

    function toggleDisclosure(entry, type) {
        if (type === 'plugins') {
            const expanded = entry.pluginCount.getAttribute('aria-expanded') === 'true';
            entry.pluginCount.setAttribute('aria-expanded', String(!expanded));
            entry.pluginCount.textContent = `${expanded ? '+' : '−'} ${new Set(entry.results.map(result => result.plugin)).size} plugins`;
            entry.pluginList.hidden = expanded;
        } else {
            const expanded = entry.lineCount.getAttribute('aria-expanded') === 'true';
            entry.lineCount.setAttribute('aria-expanded', String(!expanded));
            entry.lineCount.textContent = `${expanded ? '+' : '−'} ${entry.results.length} lines of text`;
            entry.lineList.hidden = expanded;
        }
    }

    function renderEntry(entry) {
        const results = entry.results;
        const grouped = new Map();
        for (const result of results) {
            if (!grouped.has(result.plugin)) grouped.set(result.plugin, []);
            grouped.get(result.plugin).push(result);
        }
        const plugins = [...grouped].sort((left, right) =>
            (Number(installCounts[right[0]]) || 0) - (Number(installCounts[left[0]]) || 0) || left[0].localeCompare(right[0]));
        const pluginsExpanded = entry.pluginCount.getAttribute('aria-expanded') !== 'false';
        const linesExpanded = entry.lineCount.getAttribute('aria-expanded') === 'true';
        entry.summary.hidden = results.length === 0;
        entry.pluginCount.textContent = `${pluginsExpanded ? '−' : '+'} ${plugins.length} plugins`;
        entry.pluginCount.setAttribute('aria-expanded', String(pluginsExpanded));
        entry.pluginList.hidden = !pluginsExpanded;
        entry.lineCount.textContent = `${linesExpanded ? '−' : '+'} ${results.length} lines of text`;
        entry.lineCount.setAttribute('aria-expanded', String(linesExpanded));
        entry.lineList.hidden = !linesExpanded;

        entry.pluginList.replaceChildren();
        for (const [pluginIndex, [plugin, pluginResults]] of plugins.entries()) {
            const item = document.createElement('div');
            item.className = 'plugin-item';
            if (pluginIndex % 2 === 1) item.style.backgroundColor = '#f0f0f0';
            const link = document.createElement('a');
            link.className = 'plugin-name';
            link.textContent = plugin;
            const repository = repositoryUrl(
                pluginResults[0].repository,
                pluginResults[0].commit ? `/tree/${encodeURIComponent(pluginResults[0].commit)}` : ''
            );
            if (repository) {
                link.href = repository;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
            }
            const count = document.createElement('span');
            count.textContent = ` (${(Number(installCounts[plugin]) || 0).toLocaleString()})`;
            item.append(link, count);
            entry.pluginList.append(item);
        }

        entry.lineList.replaceChildren();
        const fragment = document.createDocumentFragment();
        const sortedResults = [...results].sort((left, right) =>
            (Number(installCounts[right.plugin]) || 0) - (Number(installCounts[left.plugin]) || 0));
        for (const [index, result] of sortedResults.slice(0, MAX_RESULTS).entries()) {
            const item = document.createElement('div');
            item.className = 'line-item';
            if (index % 2 === 1) item.style.backgroundColor = '#f0f0f0';
            const link = document.createElement('a');
            const url = sourceUrl(result);
            link.href = url || '#';
            link.textContent = `${result.content} --- ${result.plugin}`;
            if (url) {
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
            } else {
                link.addEventListener('click', event => event.preventDefault());
            }
            item.append(link);
            fragment.append(item);
        }
        entry.lineList.append(fragment);
        if (results.length > MAX_RESULTS) {
            const overflow = document.createElement('div');
            overflow.className = 'summary-footer';
            overflow.textContent = `${results.length.toLocaleString()} total results (showing ${MAX_RESULTS})`;
            entry.lineList.append(overflow);
        }
    }

    async function performSearch(entry) {
        const value = entry.input.value.trim();
        if (!value || !searcher) return;
        const request = ++entry.request;
        entry.error.hidden = true;
        try {
            const results = await searcher.search(value, { caseSensitive, isRegex });
            if (request !== entry.request) return;
            entry.results = results;
            renderEntry(entry);
            saveQueries();
        } catch (error) {
            if (request !== entry.request) return;
            entry.results = [];
            entry.error.textContent = error.message;
            entry.error.hidden = false;
            renderEntry(entry);
        }
    }

    async function loadInstallCounts() {
        const versionResponse = await fetch('https://raw.githubusercontent.com/runelite/plugin-hub/master/runelite.version');
        if (!versionResponse.ok) throw new Error(`Could not load RuneLite version: HTTP ${versionResponse.status}`);
        const version = (await versionResponse.text()).trim();
        if (!/^\d+(?:\.\d+)+$/.test(version)) throw new Error('Invalid RuneLite version');
        const response = await fetch(`https://api.runelite.net/runelite-${version}/pluginhub`);
        if (!response.ok) throw new Error(`Could not load install counts: HTTP ${response.status}`);
        const counts = await response.json();
        if (!counts || typeof counts !== 'object' || Array.isArray(counts)) throw new Error('Invalid install-count data');
        return counts;
    }

    function restoreQueries() {
        try {
            if (location.hash.startsWith('#search?str=')) {
                return [decodeURIComponent(location.hash.slice('#search?str='.length))];
            }
            if (location.hash.length > 1) {
                const decoded = JSON.parse(decodeURIComponent(escape(atob(location.hash.slice(1)))));
                if (Array.isArray(decoded) && decoded.every(value => typeof value === 'string')) return decoded;
            }
        } catch {
            return [];
        }
        return [];
    }

    async function loadIndex() {
        searcher = new window.ReverseSearchBrowser.BrowserReverseSearcher(INDEX_URL.href);
        loadInstallCounts().then(counts => {
            installCounts = counts;
            for (const entry of entriesElement.children) renderEntry(entry._searchEntry);
        }).catch(error => console.warn('Install counts unavailable:', error));
        try {
            await searcher.load();
            const restored = restoreQueries();
            const queries = restored.length ? restored : ['Toa Keris Cam'];
            for (const value of queries) createEntry(value);
            if (!queries.length || queries[queries.length - 1].trim()) createEntry('');
            saveQueries();
        } catch (error) {
            const entry = createEntry('');
            entry.error.textContent = `Unable to load search index: ${error.message}`;
            entry.error.hidden = false;
        }
    }

    regexElement.addEventListener('change', () => {
        isRegex = regexElement.checked;
        for (const entry of entriesElement.children) performSearch(entry._searchEntry);
    });
    caseSensitiveElement.addEventListener('change', () => {
        caseSensitive = caseSensitiveElement.checked;
        for (const entry of entriesElement.children) performSearch(entry._searchEntry);
    });
    window.addEventListener('load', loadIndex, { once: true });

})();
