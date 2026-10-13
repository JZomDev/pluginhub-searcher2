const assert = require('node:assert/strict');
const { test } = require('node:test');

const { ScanPool } = require('../scripts/scan-pool.js');
const { fakeWorker } = require('./fake-workers.js');

const double = async task => task.n * 2;
const unusedFallback = async () => { throw new Error('fallback should not run'); };

test('tasks run on the workers, at most one per worker at a time', async () => {
    const workers = [];
    let running = 0;
    let peak = 0;
    const handle = async task => {
        running++;
        peak = Math.max(peak, running);
        await new Promise(resolve => setImmediate(resolve));
        running--;
        return task.n * 2;
    };
    const pool = new ScanPool(() => {
        const worker = fakeWorker({ handle });
        workers.push(worker);
        return worker;
    }, 2, unusedFallback);
    assert.deepEqual(await Promise.all([1, 2, 3, 4, 5].map(n => pool.scan({ n }))), [2, 4, 6, 8, 10]);
    assert.equal(peak, 2);
    assert.ok(workers.every(worker => worker.posted.length > 0));
});

test('a task the worker reports as failed is retried once in-thread', async () => {
    const worker = fakeWorker({ handle: async () => { throw new Error('bad gzip'); } });
    const fallbackTasks = [];
    const pool = new ScanPool(() => worker, 1, async task => {
        fallbackTasks.push(task);
        return 'fallback';
    });
    assert.equal(await pool.scan({ n: 1 }), 'fallback');
    assert.deepEqual(fallbackTasks, [{ n: 1 }]);
    assert.equal(pool.size, 1);
    assert.equal(worker.terminated, false);
});

test('a crashed worker is dropped and its task runs in-thread', async () => {
    const crashing = fakeWorker({ crash: true });
    const healthy = fakeWorker({ handle: double });
    const created = [crashing, healthy];
    const pool = new ScanPool(() => created.shift(), 2, async task => `fallback ${task.n}`);
    const results = await Promise.all([1, 2, 3].map(n => pool.scan({ n })));
    assert.equal(results.filter(result => String(result).startsWith('fallback')).length, 1);
    assert.equal(crashing.terminated, true);
    assert.equal(pool.size, 1);
    assert.equal(await pool.scan({ n: 4 }), 8);
});

test('when no worker loads, every task runs in-thread', async () => {
    const pool = new ScanPool(() => fakeWorker({ loadError: true }), 2, async task => task.n * 10);
    assert.deepEqual(await Promise.all([1, 2, 3].map(n => pool.scan({ n }))), [10, 20, 30]);
    assert.equal(pool.size, 0);
    assert.equal(await pool.scan({ n: 4 }), 40);
});

test('a worker that cannot be created is skipped', async () => {
    const pool = new ScanPool(() => { throw new Error('Worker is not defined'); }, 2, async task => task.n);
    assert.equal(pool.size, 0);
    assert.equal(await pool.scan({ n: 7 }), 7);
});

test('a task fails when its in-thread retry also fails', async () => {
    const pool = new ScanPool(() => fakeWorker({ crash: true }), 1, async () => { throw new Error('corrupt chunk'); });
    await assert.rejects(pool.scan({ n: 1 }), /corrupt chunk/);
});
