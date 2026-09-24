const root = "https://repo.runelite.net/plugins/";
const textDecoder = new TextDecoder();

let _cachedInstalls = null;
let _cachedVersion = null;
let _cachedManifest = null;

async function getRuneliteVersion() {
    if (_cachedVersion) {
        return _cachedVersion;
    }
    const req = await fetch("https://raw.githubusercontent.com/runelite/plugin-hub/master/runelite.version");
    _cachedVersion = (await req.text()).trim();
    return _cachedVersion;
}

async function getManifest(version) {
    if (_cachedManifest) {
        return _cachedManifest;
    }
    if (!version) {
        version = await getRuneliteVersion();
    }
    const req = await fetch(`${root}manifest/${version}_full.js`);
    const buf = new DataView(await req.arrayBuffer());
    const skip = 4 + buf.getUint32(0);
    const text = textDecoder.decode(new Uint8Array(buf.buffer.slice(skip)));
    _cachedManifest = JSON.parse(text);
    return _cachedManifest;
}

function isInternalNameAllowed(internalName) {
    if (!_cachedManifest) {
        return false;
    }
    return _cachedManifest.internalName && _cachedManifest.internalName[internalName] !== undefined;
}

async function getInstallCounts(version) {
    if (_cachedInstalls) {
        return _cachedInstalls;
    }
    if (!version) {
        version = await getRuneliteVersion();
    }
    const req = await fetch(`https://api.runelite.net/runelite-${version}/pluginhub`);
    _cachedInstalls = await req.json();
    return _cachedInstalls;
}

export { getRuneliteVersion, getInstallCounts, getManifest, isInternalNameAllowed };
