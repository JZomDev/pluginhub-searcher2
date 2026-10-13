// In-memory stand-in for the browser's CacheStorage (window.caches).

// Resolves once condition() is true, checking between event-loop turns.
async function waitFor(condition, what = 'condition') {
    for (let tick = 0; tick < 20000; tick++) {
        if (condition()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error(`Timed out waiting for ${what}`);
}

function fakeCacheStorage({ failOpen = false, failPut = false, failKeys = false } = {}) {
    const caches = new Map();
    return {
        caches,
        async open(name) {
            if (failOpen) throw new DOMException('The operation is insecure.', 'SecurityError');
            if (!caches.has(name)) {
                const entries = new Map();
                caches.set(name, {
                    entries,
                    async match(url) {
                        const bytes = entries.get(String(url));
                        return bytes ? new Response(bytes) : undefined;
                    },
                    async put(url, response) {
                        if (failPut) throw new DOMException('Quota exceeded', 'QuotaExceededError');
                        entries.set(String(url), new Uint8Array(await response.arrayBuffer()));
                    },
                    async delete(url) {
                        return entries.delete(String(url));
                    }
                });
            }
            return caches.get(name);
        },
        async keys() {
            if (failKeys) throw new Error('keys failed');
            return [...caches.keys()];
        },
        async delete(name) {
            return caches.delete(name);
        },
        // Cache writes aren't awaited by the searcher; this waits for them to land.
        waitForEntries(count) {
            const stored = () => [...caches.values()].reduce((sum, cache) => sum + cache.entries.size, 0);
            return waitFor(() => stored() >= count, `${count} cache entries`);
        }
    };
}

module.exports = { fakeCacheStorage, waitFor };
