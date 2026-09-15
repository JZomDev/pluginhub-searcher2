# Deprecate.js Split Plan

## Overview
This document outlines the strategy for splitting `deprecate.js` into separate, single-responsibility modules for easier maintenance and separation of concerns.

## Current State
`deprecate.js` (426 lines) combines:
- Version fetching from Runelite repository
- Manifest parsing and decoding
- Install count fetching
- Plugin data download and decompression
- Index building
- UI component definitions (Vue.js)
- Search functionality
- Event handlers

## Target Architecture

### Module Structure
```
deprecate.js → split into:
├── script/
│   ├── fetcher.js          # Network operations
│   ├── parser.js           # Data parsing and decoding
│   ├── indexer.js          # Index building
│   └── deprecate.js        # Main entry point
├── worker/
│   └── search-worker.js    # Search processing (for worker thread)
└── tests/
    └── test-deprecate.js   # Unit tests for each module
```

### Module Responsibilities

#### 1. `script/fetcher.js` - Network Operations
**Purpose**: Handle all HTTP requests and data fetching

**Responsibilities**:
- Fetch version from Runelite repository
- Fetch manifest from remote URL
- Fetch install counts from API
- Fetch plugin archives
- Handle progress callbacks

**API**:
```javascript
// Fetch version
const version = await fetcher.getRuneliteVersion();

// Fetch manifest
const manifest = await fetcher.getManifest(version);

// Fetch install counts
const installs = await fetcher.getInstallCounts(version);

// Fetch plugin archive
const archive = await fetcher.fetchArchive(url, onProgress);
```

#### 2. `script/parser.js` - Data Parsing
**Purpose**: Parse and decode fetched data

**Responsibilities**:
- Decompress gzip data using Node.js or browser APIs
- Parse JSON from ArrayBuffer
- Extract version from version file
- Decode manifest binary format
- Validate data integrity

**API**:
```javascript
// Decompress and parse JSON
const data = await parser.decodeJson(arrayBuffer);

// Parse manifest binary format
const manifest = parser.parseManifest(arrayBuffer);

// Extract version string
const version = parser.extractVersion(text);
```

#### 3. `script/indexer.js` - Index Building
**Purpose**: Build searchable index from plugin data

**Responsibilities**:
- Process plugin archives
- Extract file contents and line information
- Build inverted index for search
- Serialize index to binary format
- Handle progress callbacks during indexing

**API**:
```javascript
// Build index from manifest
const index = await indexer.buildIndex(manifest, onProgress);

// Serialize index to binary
const binary = indexer.serialize(index);

// Save index to file
await indexer.saveIndex(binary, outputPath);
```

#### 4. `script/deprecate.js` - Main Entry Point
**Purpose**: Orchestrate the deprecation workflow

**Responsibilities**:
- Initialize all modules
- Coordinate data fetching, parsing, and indexing
- Handle CLI arguments or UI integration
- Error handling and reporting

**API**:
```javascript
// Main entry point
import { runDeprecate } from './deprecate.js';
await runDeprecate({
  output: 'index/plugins.bin.gz',
  onProgress: (phase, current, total) => {...}
});
```

#### 5. `worker/search-worker.js` - Search Processing
**Purpose**: Handle search queries in a worker thread

**Responsibilities**:
- Load index in worker context
- Execute literal searches
- Execute regex searches
- Return formatted results

**API**:
```javascript
// Post message to worker
worker.postMessage({ type: 'SEARCH', query: 'ZigZagLayoutConfig' });

// Receive results
worker.onmessage = (e) => {
  if (e.data.type === 'SEARCH_RESULT') {
    console.log(e.data.results);
  }
};
```

## Migration Steps

### Phase 1: Extract Fetcher Module
1. Create `script/fetcher.js`
2. Move all `fetch()` calls and network logic
3. Export functions for version, manifest, installs, archives
4. Update `deprecate.js` to use new module

### Phase 2: Extract Parser Module
1. Create `script/parser.js`
2. Move `decodeJson()` and related functions
3. Add manifest parsing logic
4. Export parsing utilities
5. Update `deprecate.js` to use new module

### Phase 3: Extract Indexer Module
1. Create `script/indexer.js`
2. Move `buildIndex()` function
3. Extract AutoMap class if needed
4. Add serialization logic for binary index
5. Update `deprecate.js` to use new module

### Phase 4: Create Search Worker
1. Create `worker/search-worker.js`
2. Extract search logic from Search class
3. Implement message-based communication
4. Load index asynchronously in worker

### Phase 5: Refactor Main Entry Point
1. Simplify `deprecate.js` to orchestration only
2. Remove UI component definitions (move to separate file if needed)
3. Keep CLI/entry logic only
4. Document module interfaces

### Phase 6: Add Tests
1. Create `tests/test-deprecate.js`
2. Test each module independently
3. Test integration between modules
4. Verify end-to-end workflow

## Benefits

- **Separation of Concerns**: Each module has a single responsibility
- **Testability**: Modules can be tested in isolation
- **Maintainability**: Changes to one area don't affect others
- **Reusability**: Modules can be reused in different contexts
- **Worker Support**: Search can run in background threads
- **UI Agnostic**: Core logic separated from UI components

## Dependencies
- Node.js built-ins: `node:fs`, `node:zlib`, `node:buffer`, `node:test`
- Browser built-ins (for client): `fetch`, `DecompressionStream`
- No npm dependencies

## Notes
- UI components (Vue.js) should be moved to a separate UI module
- Worker thread communication uses `postMessage` API
- Each module exports only its public API
- Internal helpers remain private to each module
