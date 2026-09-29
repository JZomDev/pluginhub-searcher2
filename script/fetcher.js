let _cachedInstalls = null;
let _cachedVersion = null;

async function getRuneliteVersion() {
    //console.log("[FETCHER] Fetching Runelite version...");
    if (_cachedVersion) {
        return _cachedVersion;
    }
    try {
        const req = await fetch("https://raw.githubusercontent.com/runelite/plugin-hub/master/runelite.version");
        if (!req.ok) {
            throw new Error(`Failed to fetch version: ${req.status} ${req.statusText}`);
        }
        _cachedVersion = (await req.text()).trim();
        //console.log("[FETCHER] Got Runelite version:", _cachedVersion);
        return _cachedVersion;
    } catch (e) {
        console.error("[FETCHER] Failed to get Runelite version:", e.message);
        throw e;
    }
}

async function getInstallCounts(version) {
    //console.log("[FETCHER] Fetching install counts...");
    if (_cachedInstalls) {
        return _cachedInstalls;
    }
    try {
        if (!version) {
            version = await getRuneliteVersion();
        }
        const url = `https://api.runelite.net/runelite-${version}/pluginhub`;
        //console.log("[FETCHER] Fetching from:", url);
        const req = await fetch(url);
        if (!req.ok) {
            throw new Error(`Failed to fetch install counts: ${req.status} ${req.statusText}`);
        }
        _cachedInstalls = await req.json();
        //console.log("[FETCHER] Got install counts for", Object.keys(_cachedInstalls).length, "plugins");
        return _cachedInstalls;
    } catch (e) {
        console.error("[FETCHER] Failed to get install counts:", e.message);
        throw e;
    }
}

export { getInstallCounts };
