const root = "https://repo.runelite.net/plugins/";


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
        if (!version)
        {
            version = await getRuneliteVersion()
        }
        const req = await fetch(`${root}manifest/${version}_full.js`);
        const buf = new DataView(await req.arrayBuffer());
        const skip = 4 + buf.getUint32(0);
        const text = new TextDecoder("utf-8").decode(new Uint8Array(buf.buffer.slice(skip)));
        _cachedManifest = JSON.parse(text);
        return _cachedManifest;
    }

    function isInternalNameAllowed(internalName) {
        if (!_cachedManifest) {
            return false;
        }
        return _cachedManifest.internalName && _cachedManifest.internalName[internalName] !== undefined;
    }

    async function getVersion() {
        if (_cachedVersion) {
            return _cachedVersion;
        }
        const req = await fetch("https://raw.githubusercontent.com/runelite/plugin-hub/master/runelite.version");
        _cachedVersion = (await req.text()).trim();
        return _cachedVersion;
    }

    async function getInstallCounts(version) {
        if (_cachedInstalls) {
            return _cachedInstalls;
        }
        if (!version)
        {
            version = await getRuneliteVersion()
        }
        const req = await fetch(`https://api.runelite.net/runelite-${version}/pluginhub`);
        _cachedInstalls = await req.json();
        return _cachedInstalls;
    }

    async function fetchArchive(url, onProgress = () => {}) {
        const response = await fetch(url);
        const buf = await response.arrayBuffer();
        onProgress(1);
        return { buf, lastModified: response.headers.get("Last-Modified") };
    }

    async function getHash(pluginname)
    {
        let name = pluginname;
            let req = await fetch(`https://raw.githubusercontent.com/runelite/plugin-hub/master/plugins/${name}`);
            let text = await req.text();
            let prop = {};
            for (let line of text.split("\n")) {
                let kv = line.split("=", 2);
                if (kv.length == 2) {
                    prop[kv[0]] = kv[1];
                }
            }
        return prop.commit;
    }


export { getInstallCounts, getManifest, getVersion, isInternalNameAllowed };
