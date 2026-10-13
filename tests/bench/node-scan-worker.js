// worker_threads stand-in for scripts/scan-worker.js, used by search-bench.js.
const { parentPort } = require('node:worker_threads');
const ScanCore = require('../../scripts/scan-core.js');

parentPort.on('message', async ({ id, task }) => {
    try {
        parentPort.postMessage({ id, result: await ScanCore.scanBytes(task) });
    } catch (error) {
        parentPort.postMessage({ id, error: String((error && error.message) || error) });
    }
});
