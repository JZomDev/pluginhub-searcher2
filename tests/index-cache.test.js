const assert = require('node:assert/strict');
const { test } = require('node:test');

const { IndexCache } = require('../scripts/index-cache.js');
const { fakeCacheStorage } = require('./fake-cache-storage.js');

const FILE_URL = 'https://pages.example/index/chunks/0000.bin?v=new';

test('stores and returns index files for the open build', async () => {
    const cache = new IndexCache(fakeCacheStorage());
    await cache.open('new');
    assert.equal(await cache.get(FILE_URL), null);
    await cache.put(FILE_URL, new Uint8Array([1, 2, 3]));
    assert.deepEqual(await cache.get(FILE_URL), new Uint8Array([1, 2, 3]));
    await cache.delete(FILE_URL);
    assert.equal(await cache.get(FILE_URL), null);
});

test('opening a build deletes the caches of other builds only', async () => {
    const storage = fakeCacheStorage();
    await storage.open('pluginhub-index-old');
    await storage.open('some-other-app');
    await new IndexCache(storage).open('new');
    assert.deepEqual([...storage.caches.keys()].sort(), ['pluginhub-index-new', 'some-other-app']);
});

test('an unavailable cache behaves as an empty one', async () => {
    const cache = new IndexCache(fakeCacheStorage({ failOpen: true }));
    await cache.open('new');
    await cache.put(FILE_URL, new Uint8Array([1]));
    assert.equal(await cache.get(FILE_URL), null);
    await cache.delete(FILE_URL);
});

test('a failed write or purge is ignored', async () => {
    const full = new IndexCache(fakeCacheStorage({ failPut: true }));
    await full.open('new');
    await full.put(FILE_URL, new Uint8Array([1]));
    assert.equal(await full.get(FILE_URL), null);

    const unpurgeable = new IndexCache(fakeCacheStorage({ failKeys: true }));
    await unpurgeable.open('new');
    await unpurgeable.put(FILE_URL, new Uint8Array([4]));
    assert.deepEqual(await unpurgeable.get(FILE_URL), new Uint8Array([4]));
});
