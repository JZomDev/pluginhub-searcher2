// Scans text chunks off the main thread for ScanPool (scan-pool.js).
importScripts('scan-core.js');

self.onmessage = async event => {
    const { id, task } = event.data;
    try {
        self.postMessage({ id, result: await self.ScanCore.scanBytes(task) });
    } catch (error) {
        self.postMessage({ id, error: String((error && error.message) || error) });
    }
};
