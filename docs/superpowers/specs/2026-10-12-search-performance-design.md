# Search performance: faster scan, worker pool, persistent cache

Date: 2026-10-12

## Goal

Lower search latency and first-load cost in the browser for the PluginHub
searcher, hosted as static files on GitHub Pages. Build and CI time are out of
scope. The index format does not change, so no rebuild or migration is needed.
Targets are desktop and mobile.

## Background (measured)

A Node harness around `BrowserReverseSearcher` over the real index (2,760
plugins, 51,860 files, 103 MB: 30 MB shards, 70 MB chunks) showed:

| Query | Cold, no network cost | Cold, 50 Mbps / 20 ms | Warm |
|---|---|---|---|
| Rare literal | 78 ms, 4.5 MB | 761 ms | 51 ms |
| Default (`Toa Keris Cam`) | 33 ms, 2.1 MB | 377 ms | 21 ms |
| Common literal / 2-char / regex with no literal | 1.8-2.1 s, 73 MB | 11.8 s | 1.6-2.0 s |

Common queries are CPU-bound on the main thread even when cached, and every
return visit is a cold start because Pages sends `Cache-Control: max-age=600`.

## Scope

In scope:

1. **Faster scan (scan-core).** Replace the per-line scan of every candidate
   file with an `indexOf` search over the whole file, computing line
   boundaries only around hits.
2. **Worker pool.** Run chunk scanning in a pool of Web Workers.
3. **Persistent cache.** Keep downloaded index files in the Cache API across
   visits, keyed by build.

Out of scope: debounce changes, file dedupe, better compression or wasm, any
index-format change, and changes to the build scripts or workflows.

Results must be identical to the current implementation for the same query and
options.

## Design

### Public API

`BrowserReverseSearcher` keeps `load()`, `prefetch()` and `search()`, and
`requiredRegexLiterals` stays exported. `app.js` and the existing tests keep
working unchanged.

### Files

- `scripts/scan-core.js` (new): pure function scanning one decoded chunk.
  Loaded by the worker with `importScripts` and called directly as the
  in-thread fallback.
- `scripts/scan-worker.js` (new): thin shell. On a message it gunzips the chunk
  with `DecompressionStream`, decodes and parses it, calls `scan-core`, and
  posts results back.
- `scripts/reverse-search-browser.js` (changed): adds the worker pool and a
  persistent-cache layer under `_compressed`. The decoded-chunk LRU is removed;
  workers do not retain decoded text (mobile memory).
- `index.html`: adds a script tag for `scan-core.js`. The workflows already
  copy `scripts/` wholesale.

### One search, end to end

1. Main extracts literals and looks up shards; intersecting postings gives
   candidate file ids (unchanged).
2. Main groups candidates by chunk and fetches each chunk's compressed bytes:
   Cache API first, network second, with the existing retry and concurrency
   limits. New files are written to the cache.
3. Main sends each chunk to the next free worker with the file ids, the query
   options, and a priority table (rank per plugin index, built once per search
   from `installs`, since a function cannot cross the thread boundary).
4. Each worker scans its chunk and keeps only its top `limit` lines using the
   current comparison. It returns those lines plus per-plugin line counts.
5. Main merges partial results, keeps the top `limit`, and reports progress at
   the existing 200 ms interval.
6. Abort stops dispatching new chunks. Chunks in flight finish and are ignored
   by search id.

### Pool and fallback

Pool size is `min(4, hardwareConcurrency - 1)`, minimum one. If `Worker`,
`DecompressionStream` or the Cache API is unavailable (Node tests, some
private-browsing modes), the searcher falls back to the in-thread scan and
in-memory caching with identical results.

### scan-core behaviour

- **Literal search:** an `indexOf` loop over the (lowercased, when
  case-insensitive) content, with line numbers counted incrementally between
  hits. Line splitting matches the current `splitLines` (`\r\n`, `\n`, `\r`;
  a trailing terminator does not add a line).
- **Queries containing `\n` or `\r`:** match nothing, as today, because
  matching is per line.
- **Regex:** stays per-line (whole-file matching would change `.`, `^`, `$`).
  The required literals from the trigram step add a cheap file-level prefilter.
- **Lowercasing length change:** if `content.toLowerCase().length` differs from
  `content.length` (e.g. `İ`), that file uses the per-line path so offsets stay
  correct.

### Persistent cache lifecycle

After `load()` reads the manifest, entries for other builds are deleted, then
the current build's entries are used. Files are addressed as
`<name>.bin?v=<build>`, so a stored response is unique per build. Prefetch
writes into the cache, so a return visit finds everything local. The manifest
is still fetched with `cache: 'no-cache'`.

## Error handling

Failures in optional layers must never fail a search that previously worked.

- Worker error or crash: retry that chunk once in-thread; if it still fails,
  the search reports the error as a failed fetch does today.
- Worker script fails to load: use the in-thread scan for the rest of the
  session.
- Cache API errors (quota, read or write failure): treated as a miss; write
  failures are ignored.
- Corrupt cached entry (gunzip fails): delete it and refetch once.
- Purge of old builds fails: non-fatal.
- Two tabs on different builds during an index update may evict each other's
  cache once; accepted.

## Testing

- **Parity:** keep the current line-by-line scan in the test file as an oracle
  and compare it with scan-core on fixtures and randomised inputs covering
  `\r\n`, lone `\r`, trailing newlines, empty files, queries with newlines,
  case-sensitive and insensitive modes, and Unicode.
- **Pool:** injectable worker factory; tests use a fake in-thread worker and
  cover dispatch, merging, limit, abort, retry and fallback.
- **Cache layer:** injectable cache store; tests cover hit, miss, purge of
  other builds, corrupt entry, and unavailable.
- **Existing suites:** `tests/reverse-search.test.js` and the Python tests pass
  unchanged.
- **Real workers:** verified manually in Chrome and Firefox, including mobile
  emulation.

## Success criteria

Measured with the same benchmark harness as the background numbers:

- Results identical to today's for every benchmark query.
- Rare and default queries no slower than now.
- Warm common queries (currently 1.6-2.0 s) at least 2x faster from the scan
  change alone; the improvement from workers is reported as measured.
- A return visit with a warm cache makes exactly one network request (the
  manifest).
- Peak memory on the 73 MB queries below today's.
