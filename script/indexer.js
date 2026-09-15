import { decodeJson } from "./parser.js";

async function buildIndex(manifest, manifestData, onProgress = () => {}) {
    const fileIndexes = new Map();
    let lastModified = new Date(0);

    const promises = manifestData.map(async (entry, i) => {
        const url = "docs/" + entry.zipname;
        const response = await fetch(url);
        const buf = await response.arrayBuffer();

        const lastMod = response.headers.get("Last-Modified");
        if (lastMod) {
            const dt = new Date(lastMod);
            if (!isNaN(dt) && dt > lastModified) {
                lastModified = dt;
            }
        }

        const parsedData = await decodeJson(buf);
        fileIndexes.set(entry.zipname, parsedData);
        onProgress(i + 1);
    });

    await Promise.all(promises);

    fileIndexes.lastModified = lastModified;
    return fileIndexes;
}

export { buildIndex };
