const ScanCore = require('../scripts/scan-core.js');

// Stand-in for a Web Worker running scripts/scan-worker.js. Messages are copied
// with structuredClone, as postMessage would, and answered asynchronously by
// handle(task). `crash` fires onerror instead of answering; `loadError` fires
// onerror as soon as the worker is created, like a missing worker script.
function fakeWorker({ handle = ScanCore.scanBytes, crash = false, loadError = false } = {}) {
    const worker = {
        onmessage: null,
        onerror: null,
        posted: [],
        terminated: false,
        postMessage(message) {
            const copy = structuredClone(message);
            worker.posted.push(copy);
            setImmediate(async () => {
                if (worker.terminated) return;
                if (crash) {
                    worker.onerror?.({ message: 'worker crashed' });
                    return;
                }
                let reply;
                try {
                    reply = { id: copy.id, result: structuredClone(await handle(copy.task)) };
                } catch (error) {
                    reply = { id: copy.id, error: error.message };
                }
                if (!worker.terminated) worker.onmessage?.({ data: reply });
            });
        },
        terminate() {
            worker.terminated = true;
        }
    };
    if (loadError) setImmediate(() => worker.onerror?.({ message: 'scan-worker.js: HTTP 404' }));
    return worker;
}

module.exports = { fakeWorker };
