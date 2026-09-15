async function decodeJson(buf) {
    const bytes = new Uint8Array(buf);
    let text;
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
        const stream = new Response(buf).body.pipeThrough(new DecompressionStream("gzip"));
        text = await new Response(stream).text();
    } else {
        text = new TextDecoder("utf-8").decode(buf);
    }
    return JSON.parse(text);
}

async function decodeJsonWithProgress(buf, onProgress = () => {}) {
    const bytes = new Uint8Array(buf);
    let text;
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
        const stream = new Response(buf).body.pipeThrough(new DecompressionStream("gzip"));
        text = await new Response(stream).text();
        onProgress(1);
    } else {
        text = new TextDecoder("utf-8").decode(buf);
    }
    return JSON.parse(text);
}

export { decodeJson, decodeJsonWithProgress };
