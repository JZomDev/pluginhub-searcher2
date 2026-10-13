(function (root) {
    'use strict';

    // Keeps downloaded index files in the Cache API across visits, one cache per
    // index build. Every failure acts as a miss, so searches never depend on it.
    class IndexCache {
        constructor(cacheStorage, prefix = 'pluginhub-index-') {
            this.cacheStorage = cacheStorage;
            this.prefix = prefix;
            this.cache = null;
        }

        // Opens the cache for `build` and deletes the caches of every other build.
        async open(build) {
            const name = this.prefix + build;
            try {
                this.cache = await this.cacheStorage.open(name);
            } catch (error) {
                console.warn('Index cache unavailable:', error);
                return;
            }
            try {
                const names = await this.cacheStorage.keys();
                await Promise.all(names
                    .filter(other => other.startsWith(this.prefix) && other !== name)
                    .map(other => this.cacheStorage.delete(other)));
            } catch (error) {
                console.warn('Could not delete old index caches:', error);
            }
        }

        async get(url) {
            if (!this.cache) return null;
            try {
                const response = await this.cache.match(url);
                return response ? new Uint8Array(await response.arrayBuffer()) : null;
            } catch {
                return null;
            }
        }

        async put(url, bytes) {
            if (!this.cache) return;
            try {
                await this.cache.put(url, new Response(bytes));
            } catch {
                // Full or unavailable: the file is downloaded again next visit.
            }
        }

        async delete(url) {
            if (!this.cache) return;
            try {
                await this.cache.delete(url);
            } catch {
                // A stale entry that can't be deleted fails to decode and is refetched.
            }
        }
    }

    if (typeof module !== 'undefined' && module.exports) module.exports = { IndexCache };
    root.IndexCache = IndexCache;
})(typeof globalThis !== 'undefined' ? globalThis : this);
