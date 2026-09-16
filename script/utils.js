function getPluginName(filename) {
    return filename.split('/').pop().replace('.jar', '');
}

function getInstalls(pluginName, installCounts) {
    const count = installCounts[pluginName];
    return count != null ? +count : 0;
}

function parseProperties(text) {
    const prop = {};
    for (const line of text.split('\n')) {
        const kv = line.split('=', 2);
        if (kv.length === 2) {
            prop[kv[0]] = kv[1];
        }
    }
    return prop;
}

export { getPluginName, getInstalls, parseProperties };
