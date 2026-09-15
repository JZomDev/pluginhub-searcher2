const fs = require('fs');
const path = require('path');

async function bundle() {
    const scriptDir = path.join(__dirname, '..', 'script');
    const outputDir = path.join(__dirname, '..', '.kilo');

    const fetcherContent = fs.readFileSync(path.join(scriptDir, 'fetcher.js'), 'utf-8');
    const parserContent = fs.readFileSync(path.join(scriptDir, 'parser.js'), 'utf-8');
    const searchContent = fs.readFileSync(path.join(scriptDir, 'search.js'), 'utf-8');
    const mainContent = fs.readFileSync(path.join(scriptDir, 'main.js'), 'utf-8');

    let bundled = '';

    bundled += '// Auto-generated bundle from script modules\n';
    bundled += '// Do not edit manually\n\n';

    bundled += fetcherContent.replace('export { Fetcher };', '');
    bundled += '\n';

    bundled += parserContent.replace('export { decodeJson, decodeJsonWithProgress };', '');
    bundled += '\n';

    bundled += searchContent.replace('export { parseBinaryIndex, searchIndex };', '');
    bundled += '\n';

    bundled += mainContent;

    fs.writeFileSync(path.join(outputDir, 'deprecate-bundle.js'), bundled);
    console.log('Bundle created successfully');
}

bundle().catch(console.error);
