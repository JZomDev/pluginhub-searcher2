# Index Builder Specification

## Overview
This document describes the `script/index-builder.js` script responsible for creating `index/plugins.bin.gz` from the raw plugin archives in `/plugins/*.gz`.

## Input
- Raw plugin data: `/plugins/plugins_0.json.gz` (and subsequent splits)
- Each `.json.gz` contains a JSON array of plugin entries with:
  - `commit`: Git commit hash
  - `repository`: GitHub repository URL
  - `internalName`: Plugin identifier (e.g., "zom-zigzag")
  - `files`: Array of file entries with `fileName`, `content`, and `filePath`

## Output
- File: `index/plugins.bin.gz`
- Format: Gzip-compressed binary index for client-side search

## Binary Index Format

### Structure
The index uses a compact binary format with string deduplication:

```
[FileCount][FileEntries...][StringTableOffset][StringTable...]
```

#### File Entries
Each file entry contains:
- `fileNameLength` (uint16): Length of file name
- `fileName` (bytes): UTF-8 encoded file name
- `fileOffset` (uint32): Offset to content in string table
- `contentLength` (uint32): Length of content in bytes
- `lineOffsets` (uint16[]): Array of line start offsets (relative to content start)

#### String Table
- Contains all file contents concatenated
- Each file's content is separated by a newline
- Deduplicated strings are referenced by index

### JSON Representation (for reference)
```json
{
  "ZigZagLayoutConfig": [
    {
      "internalname": "zom-zigzag",
      "files": {
        "src/main/java/com/zom/ZigZagLayoutConfig.java": [7, 10],
        "src/main/java/com/zom/ZigZagLayoutPlugin.java": [44, 289, 296, 298]
      }
    }
  ]
}
```

## Processing Steps

1. **Parse all plugin archives**
   - Read each `/plugins/plugins_N.json.gz` file
   - Decompress using `node:zlib`
   - Parse JSON to extract file contents

2. **Build line index**
   - For each file, split content by newlines
   - Store content in string table
   - Record line offsets for efficient searching

3. **Create inverted index**
   - For each unique line, track which (plugin, file, line) tuples contain it
   - Group by plugin for query results

4. **Serialize to binary**
   - Write file entries with offsets
   - Append string table
   - Compress with `node:zlib.gzipSync`

5. **Write output**
   - Create `index/` directory if needed
   - Write `plugins.bin.gz`

## Search Query Format

### Literal Search
- Case-sensitive substring match
- Returns all (plugin, file, line) tuples where content.includes(searchTerm)

### Regex Search
- JavaScript RegExp against file paths and symbols
- Returns matching entries with line numbers

## Dependencies
- Node.js built-ins only: `node:fs`, `node:zlib`, `node:buffer`
- No npm dependencies
- No external services

## Example Usage
```bash
node script/index-builder.js
```
