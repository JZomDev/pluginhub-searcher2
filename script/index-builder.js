import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";

let _cachedManifest = null;


async function loadManifest() {
    if (_cachedManifest) {
        return _cachedManifest;
    }

   let version = await getVersion();
   version = version.trim()
    const root = "https://repo.runelite.net/plugins/";
    const req = await fetch(`${root}manifest/${version}_full.js`);
    const buf = new DataView(await req.arrayBuffer());
    const skip = 4 + buf.getUint32(0);
    const text = new TextDecoder("utf-8").decode(new Uint8Array(buf.buffer.slice(skip)));
    _cachedManifest = JSON.parse(text);
    return _cachedManifest;
}

async function isInternalNameAllowed(internalName) {
    return _cachedManifest.jars.some(item => item.internalName === internalName);
}

async function getVersion() {
    const req = await fetch("https://raw.githubusercontent.com/runelite/plugin-hub/master/runelite.version");
    return await req.text();
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

    async run(inputGlob, outputFile, outputGzFile, onProgress = () => {}) {

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
                const allowed = await isInternalNameAllowed(internalName);
                if (!allowed) continue;
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

        writeFileSync(outputFile, buffer);
        writeFileSync(outputGzFile, gzipped);

        return {
            binarySize: buffer.length,
            gzippedSize: gzipped.length,
            fileCount: this.fileEntries.length,
            stringTableSize: Buffer.byteLength(this.stringTable, "utf8")
        };
    }
}

function extractIdentifiers(line) {
    const keywords = new Set([
        "public", "private", "protected", "static", "final", "abstract",
        "class", "interface", "enum", "extends", "implements", "import",
        "package", "return", "if", "else", "for", "while", "do", "switch",
        "case", "break", "continue", "new", "this", "super", "void",
        "boolean", "int", "long", "double", "float", "char", "byte",
        "short", "true", "false", "null", "override", "throws",
        "try", "catch", "finally", "throw", "synchronized",
        "var", "const", "let", "function", "async", "await",
        "String", "Integer", "Long", "Double", "Float", "Boolean",
        "Object", "List", "Map", "Set", "Collection", "Optional",
        "Override", "Inject", "Provides", "Slf4j", "Log",
        "ConfigGroup", "ConfigItem", "Config", "Plugin", "PluginDescriptor",
        "PluginDependency", "PluginManager", "Client", "Widget", "WidgetItem",
        "MenuItem", "GameObject", "NPC", "Player", "LocalPlayer",
        "Canvas", "Graphics2D", "Color", "Font", "BasicStroke",
        "Point", "Rectangle", "Dimension", "Insets", "Toolkit",
        "Timer", "ScheduledExecutorService", "Executor", "Future",
        "CompletableFuture", "AtomicInteger", "AtomicBoolean",
        "HashMap", "ArrayList", "LinkedList", "HashSet", "TreeSet",
        "TreeMap", "ConcurrentHashMap",
        "ImmutableSet", "ImmutableMap", "ImmutableList",
        "Guice", "ProvisionException",
        "Logger", "Logging",
        "Slf4j", "Log",
        "Inject", "Qualifier", "Singleton", "Component",
        "Override", "Deprecated", "SuppressWarnings",
        "lombok", "Builder", "AllArgsConstructor", "NoArgsConstructor",
        "Data", "ToString", "EqualsAndHashCode",
        "Getter", "Setter"
    ]);

    const code = line
        .replace(/\/\/.*$/, "")
        .replace(/"[^"]*"/g, "")
        .replace(/@\w+/g, "");

    const identifiers = new Set();
    const annotationMatch = line.match(/@(\w+)/g);
    if (annotationMatch) {
        for (const match of annotationMatch) {
            const ident = match.substring(1);
            if (ident.length >= 3) {
                identifiers.add(ident);
            }
        }
    }

    let match;
    const identifierRegex = /\b([A-Z]\w*)\b/g;
    while ((match = identifierRegex.exec(code)) !== null) {
        const found = match[1];
        if (!keywords.has(found) && found !== "String" && found.length >= 3) {
            identifiers.add(found);
        }
    }

    const methodRegex = /\b([a-z][a-zA-Z0-9]+)\b/g;
    while ((match = methodRegex.exec(code)) !== null) {
        const found = match[1];
        if (!keywords.has(found) && found.length >= 2) {
            identifiers.add(found);
        }
    }

    return [...identifiers];
}

export { BinaryIndexBuilder };

const builder = new BinaryIndexBuilder();
await builder.run("plugins/plugins_*.json.gz", "index/plugins.bin", "index/plugins.bin.gz");
