import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { getRuneliteVersion } from "./fetcher.js";

let _cachedManifest = null;


async function loadManifest() {
    if (_cachedManifest) {
        return _cachedManifest;
    }

   let version = await getRuneliteVersion();
   version = version.trim()
    const root = "https://repo.runelite.net/plugins/";
    const req = await fetch(`${root}manifest/${version}_full.js`);
    const buf = new DataView(await req.arrayBuffer());
    const skip = 4 + buf.getUint32(0);
    const text = new TextDecoder("utf-8").decode(new Uint8Array(buf.buffer.slice(skip)));
    _cachedManifest = JSON.parse(text);
    return _cachedManifest;
}

async function isInternalNameAllowed(internalName, devmode) {
    // test package is only to use zom-zigzag to speed up testing
    if (devmode && internalName !== 'zom-zigzag')
    {
        return false;
    }
    return _cachedManifest.jars.some(item => item.internalName === internalName);
}

async function glob(pattern) {
    const dir = pattern.substring(0, pattern.lastIndexOf("/"));
    const filePattern = pattern.substring(pattern.lastIndexOf("/") + 1);
    const regex = new RegExp("^" + filePattern.replace("*", ".*") + "$");
    const files = readdirSync(dir).filter(f => f.endsWith(".json") || f.endsWith(".json.gz"));
    return files
        .filter(f => regex.test(f))
        .map(f => `${dir}/${f}`);
}

class BinaryIndexBuilder {
    constructor() {
        this.fileEntries = [];
        this.stringTable = "";
    }

    addFile(pluginInternalName, fileName, filePath, content) {
        this.fileEntries.push({
            pluginInternalName,
            fileName,
            filePath,
            content
        });
    }

    buildRawStringTable() {
        let offset = 0;
        for (const entry of this.fileEntries) {
            entry._stringOffset = offset;
            entry._contentLength = entry.content.length;
            this.stringTable += entry.content;
            offset += entry._contentLength;
            if (entry !== this.fileEntries[this.fileEntries.length - 1]) {
                this.stringTable += "\n";
                offset += 1;
            }
        }
    }

    buildLineOffsets() {
        for (const entry of this.fileEntries) {
            const lines = entry.content.split("\n");
            const offsets = [];
            let pos = 0;
            for (let i = 0; i < lines.length; i++) {
                if(lines[i].trim() == '') continue;
                if(lines[i].trim() == '}') continue;
                if(lines[i].trim() == '{') continue;
                offsets.push(pos);
                pos += lines[i].length + 1;
            }
            entry._lineOffsets = offsets;
        }
    }

    buildBinaryIndex() {
        const entryCount = this.fileEntries.length;
        let binarySize = 4;
        const entrySize = 2 + 2 + 4 + 4 + 2;

        for (const entry of this.fileEntries) {
            const fileNameBytes = Buffer.from(entry.filePath, "utf8");
            const pluginNameBytes = Buffer.from(entry.pluginInternalName, "utf8");
            const lineCount = entry._lineOffsets.length;
            binarySize += entrySize + fileNameBytes.length + pluginNameBytes.length + lineCount * 4;
        }
        binarySize += 4;
        binarySize += Buffer.byteLength(this.stringTable, "utf8");

        const buffer = Buffer .alloc(binarySize);
        let pos = 0;

        buffer.writeUInt32LE(entryCount, pos);
        pos += 4;

        for (const entry of this.fileEntries) {
            const fileNameBytes = Buffer.from(entry.filePath, "utf8");
            const fileNameLength = fileNameBytes.length;
            const pluginNameBytes = Buffer.from(entry.pluginInternalName, "utf8");
            const pluginNameLength = pluginNameBytes.length;
            const lineOffsets = entry._lineOffsets;

            buffer.writeUInt16LE(fileNameLength, pos);
            pos += 2;

            fileNameBytes.copy(buffer, pos);
            pos += fileNameLength;

            buffer.writeUInt16LE(pluginNameLength, pos);
            pos += 2;

            pluginNameBytes.copy(buffer, pos);
            pos += pluginNameLength;

            buffer.writeUInt32LE(entry._stringOffset, pos);
            pos += 4;

            buffer.writeUInt32LE(entry._contentLength, pos);
            pos += 4;

            buffer.writeUInt16LE(lineOffsets.length, pos);
            pos += 2;

            for (let i = 0; i < lineOffsets.length; i++) {
                buffer.writeUInt32LE(lineOffsets[i], pos);
                pos += 4;
            }
        }

        buffer.writeUInt32LE(pos, binarySize - 4);

        const stringTableBytes = Buffer.from(this.stringTable, "utf8");
        stringTableBytes.copy(buffer, pos);

        return buffer;
    }

    async run(inputGlob, outputFile, outputGzFile, devmode, onProgress = () => {}, 
              skipIfExists = false, outputBinary = true) {
        console.log('devmode: ' + devmode)
        
        // Check if gz file already exists and skip if requested
        if (skipIfExists && existsSync(outputGzFile)) {
            console.log('Index already exists, skipping build');
            return {
                binarySize: 0,
                gzippedSize: 0,
                fileCount: 0,
                stringTableSize: 0
            };
        }
        
        await loadManifest();
        const pluginFiles = await glob(inputGlob);

        let processed = 0;

        for (const pluginFile of pluginFiles) {
            onProgress(processed, pluginFiles.length);
            let data;
            // Decompress .gz files before parsing JSON
            if (pluginFile.endsWith(".gz")) {
                const { gunzipSync } = await import("node:zlib");
                const gzData = readFileSync(pluginFile);
                const buffer = gunzipSync(gzData);
                data = JSON.parse(buffer.toString("utf8"));
            } else {
                data = JSON.parse(readFileSync(pluginFile, "utf8"));
            }
            processed++;
            onProgress(processed, pluginFiles.length);

            for (const plugin of data) {
                if (!plugin.internalName || !Array.isArray(plugin.files)) continue;
                const { internalName, files } = plugin;
                const allowed = await isInternalNameAllowed(internalName, devmode);
                if (!allowed) 
                {
                    console.log("Skipping: " + plugin.internalName)
                    continue;
                }
                console.log("Processing: " + plugin.internalName)
                for (const file of files) {
                    this.addFile(internalName, file.fileName || "", file.filePath || "", file.content || "");
                }
            }
        }

        this.buildLineOffsets();
        this.buildRawStringTable();

        const buffer = this.buildBinaryIndex();
        const gzipped = gzipSync(buffer);

        const indexDir = outputFile ? outputFile.substring(0, outputFile.lastIndexOf("/")) : "index";
        const gzDir = outputGzFile ? outputGzFile.substring(0, outputGzFile.lastIndexOf("/")) : "index";
        if (!existsSync(indexDir)) mkdirSync(indexDir, { recursive: true });
        if (!existsSync(gzDir)) mkdirSync(gzDir, { recursive: true });

        if (outputBinary && outputFile) {
            writeFileSync(outputFile, buffer);
        }
        writeFileSync(outputGzFile, gzipped);

        const manifest = {
            lastModified: new Date().toISOString()
        };
        const manifestPath = outputGzFile.replace(/\.gz$/, ".manifest.json");
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

        return {
            binarySize: buffer.length,
            gzippedSize: gzipped.length,
            fileCount: this.fileEntries.length,
            stringTableSize: Buffer.byteLength(this.stringTable, "utf8")
        };
    }
}

export { BinaryIndexBuilder };

// Only run this when executed directly, not when imported
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    const builder = new BinaryIndexBuilder();
    await builder.run("plugins/plugins_*.json.gz", "plugins/plugins.bin", "plugins/plugins.bin.gz", false);
}
