# Search Index Specification

## Overview
This document describes the search functionality that queries `index/plugins.bin.gz` to find literal string matches and regex patterns across all plugin source code.

## Input
- Index file: `index/plugins.bin.gz`
- Search query: string (literal) or regex pattern

## Output Format
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

### Field Descriptions
- **Key**: Plugin class/interface name found in the search (e.g., "ZigZagLayoutConfig")
- **Value**: Array of result objects for this plugin
  - `internalname`: The plugin's internal identifier (e.g., "zom-zigzag")
  - `files`: Object mapping file paths to arrays of line numbers
    - Key: File path within the plugin archive
    - Value: Array of 1-indexed line numbers where the search term appears

## Search Modes

### Literal Search
- Uses `String.prototype.includes()` semantics
- Case-sensitive matching
- Searches all content lines in the index
- Returns all (plugin, file, line) tuples containing the substring

### Regex Search
- JavaScript RegExp against file paths
- Symbol matching against extracted identifiers
- Supports capture groups for advanced queries
- Returns matching entries with context

## Binary Index Query Process

1. **Load and decompress**
   - Read `index/plugins.bin.gz`
   - Decompress using `node:zlib.gunzipSync`

2. **Parse binary index**
   - Read file count and iterate through file entries
   - Build content lookup using string table offsets

3. **Execute search**
   - For literal: iterate all content lines, check substring match
   - For regex: apply RegExp to file paths and symbols

4. **Format results**
   - Group by plugin name
   - Collect line numbers per file
   - Return in specified JSON format

## Performance Considerations

- Index is self-contained; no external API calls required
- Search happens entirely in-memory after index load
- Line number arrays are pre-computed during index build
- Binary format minimizes disk I/O and memory footprint

## Dependencies
- Node.js built-ins: `node:fs`, `node:zlib`, `node:buffer`, `DataView`, `Uint32Array`
- Browser built-ins (for client-side): `fetch`, `DecompressionStream`
- No npm dependencies

## Example Query
```javascript
// Literal search
const results = await searchIndex("ZigZagLayoutConfig");
// Returns all occurrences of "ZigZagLayoutConfig" in plugin source

// Regex search
const results = await searchIndex(/RunePouchPlacement/);
// Returns all matches for the pattern
```
