(function (root) {
    'use strict';

    // Runs scan tasks on a pool of workers, one task per worker at a time. A task
    // whose worker fails is retried once with `fallback` (the in-thread scan); a
    // worker that errors is dropped, and once none are left every task runs on
    // `fallback`.
    class ScanPool {
        constructor(createWorker, size, fallback) {
            this.fallback = fallback;
            this.workers = new Set();
            this.idle = [];
            this.queue = [];
            // Running job by worker.
            this.running = new Map();
            this.nextId = 1;
            for (let index = 0; index < size; index++) {
                let worker;
                try {
                    worker = createWorker();
                } catch (error) {
                    console.warn('Scan worker unavailable:', error);
                    continue;
                }
                worker.onmessage = event => this._finished(worker, event.data);
                worker.onerror = event => this._failed(worker, event);
                this.workers.add(worker);
                this.idle.push(worker);
            }
        }

        get size() {
            return this.workers.size;
        }

        scan(task) {
            if (!this.workers.size) return this.fallback(task);
            return new Promise((resolve, reject) => {
                this.queue.push({ id: this.nextId++, task, resolve, reject });
                this._dispatch();
            });
        }

        _dispatch() {
            while (this.idle.length && this.queue.length) {
                const worker = this.idle.pop();
                const job = this.queue.shift();
                this.running.set(worker, job);
                worker.postMessage({ id: job.id, task: job.task });
            }
        }

        _finished(worker, { id, result, error }) {
            const job = this.running.get(worker);
            if (!job || job.id !== id) return;
            this.running.delete(worker);
            this.idle.push(worker);
            if (error === undefined) job.resolve(result);
            else this._runInThread(job);
            this._dispatch();
        }

        // The worker crashed or its script never loaded.
        _failed(worker, event) {
            event?.preventDefault?.();
            console.warn('Scan worker failed:', event?.message || event);
            const job = this.running.get(worker);
            this.running.delete(worker);
            this.workers.delete(worker);
            this.idle = this.idle.filter(other => other !== worker);
            worker.terminate();
            if (job) this._runInThread(job);
            if (this.workers.size) this._dispatch();
            else for (const queued of this.queue.splice(0)) this._runInThread(queued);
        }

        _runInThread(job) {
            Promise.resolve().then(() => this.fallback(job.task)).then(job.resolve, job.reject);
        }
    }

    if (typeof module !== 'undefined' && module.exports) module.exports = { ScanPool };
    root.ScanPool = ScanPool;
})(typeof globalThis !== 'undefined' ? globalThis : this);
