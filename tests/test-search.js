const assert = require('assert');
const path = require('path');

const { BinarySearcher } = require('../scripts/search_binary.js');

const INDEX_PATH = path.join(__dirname, '..', 'plugins', 'test-index.bin.lz4');
const TESTS_PASSED = [];
const TESTS_FAILED = [];
let sharedSearcher = null;

async function runTest(name, testFn) {
    try {
        await testFn();
        TESTS_PASSED.push(name);
        console.log(`✓ ${name}`);
    } catch (err) {
        TESTS_FAILED.push({ name, error: err.message });
        console.error(`✗ ${name}: ${err.message}`);
    }
}

async function testBasicSearch() {
    const result = await sharedSearcher.search('import');
    
    assert(result.count >= 0, 'result count should be a number');
}

async function testSearchReturnsCount() {
    const result = await sharedSearcher.search('function');
    
    assert(typeof result.count === 'number', 'count should be a number');
    assert(result.results.length === result.count, 'results array length should match count');
}

async function testSearchWithNoResults() {
    const result = await sharedSearcher.search('xyznonexistent12345');
    
    assert(result.count === 0, 'should return 0 results for non-existent term');
    assert(Array.isArray(result.results), 'results should be an array');
}

async function testSearchReturnsResults() {
    const result = await sharedSearcher.search('require');
    
    assert(result.count > 0, 'should find results for common term like require');
    assert(Array.isArray(result.results), 'results should be an array');
}

async function testCaseInsensitiveSearch() {
    const resultUpper = await sharedSearcher.search('IMPORT');
    const resultLower = await sharedSearcher.search('import');
    
    assert(resultUpper.count === resultLower.count, 'search should be case-insensitive by default (both uppercase and lowercase map to same index entry)');
}

async function testSearchRecordStructure() {
    const result = await sharedSearcher.search('module.exports');
    
    if (result.results.length > 0) {
        const record = result.results[0];
        assert(record.plugin, 'record should have plugin field');
        assert(record.filePath, 'record should have filePath field');
        assert(record.line !== undefined, 'record should have line field');
        assert(record.content, 'record should have content field');
    }
}

async function testRecordCountMatchesManifest() {
    const indexedCount = sharedSearcher.getRecordCount();
    assert(indexedCount > 0, 'should have indexed records');
}

async function testCaseSensitiveSearch() {
    const resultCaseSensitive = await sharedSearcher.search('IMPORT', { caseSensitive: true });
    const resultCaseInsensitive = await sharedSearcher.search('IMPORT', { caseSensitive: false });
    
    assert(typeof resultCaseSensitive.count === 'number', 'case-sensitive search should return count');
    assert(typeof resultCaseInsensitive.count === 'number', 'case-insensitive search should return count');
}

async function testSearchToaKerisCam() {
    const result = await sharedSearcher.search('Toa Keris Cam', { caseSensitive: true });

    assert.strictEqual(result.count, 1, result.count);
    assert.strictEqual(result.results[0].plugin, 'zom-keris-cam');
    assert.strictEqual(result.results[0].filePath, 'src/main/java/com/zom/TOAKerisCamPlugin.java');
    assert.strictEqual(result.results[0].line, 39);
    assert.strictEqual(result.results[0].content, '\tname = "Toa Keris Cam"');
}

async function testSearchDoesNotSearchPluginMetadata() {
    const result = await sharedSearcher.search('zom-keris-cam', { caseSensitive: true });

    assert.strictEqual(result.count, 0, result.count);
}

async function testSearchRunePouchPlacementCaseSensitive() {
    const result = await sharedSearcher.search('RunePouchPlacement', { caseSensitive: true });

    assert.strictEqual(result.count, 6, result.count);
}

async function testSearchRunePouchPlacementCaseInsensitive() {
    const result = await sharedSearcher.search('runepouchplacement', { caseSensitive: false });

    assert.strictEqual(result.count, 7, result.count);
}

async function runAllTests() {
    console.log('Running search tests...\n');
    
    // Initialize shared searcher once before any tests
    console.log('Initializing index...');
    const startTime = Date.now();
    sharedSearcher = new BinarySearcher();
    await sharedSearcher.loadIndex(INDEX_PATH);
    const loadTime = (Date.now() - startTime) / 1000;
    console.log(`Indexed ${sharedSearcher.getRecordCount()} records in ${loadTime.toFixed(2)}s\n`);
    
    // Run all tests using the same indexed searcher
    // await runTest('Basic search returns result object', testBasicSearch);
    // await runTest('Search returns count matching results length', testSearchReturnsCount);
    // await runTest('Non-existent term returns zero results', testSearchWithNoResults);
    // await runTest('Common term finds results', testSearchReturnsResults);
    // await runTest('Case-insensitive search (default)', testCaseInsensitiveSearch);
    // await runTest('Search record has required fields', testSearchRecordStructure);
    // await runTest('Indexed count matches manifest total', testRecordCountMatchesManifest);
    // await runTest('Case-sensitive search option', testCaseSensitiveSearch);
    await runTest('Search "Toa Keris Cam" returns the exact content line', testSearchToaKerisCam);
    await runTest('Search does not use plugin metadata', testSearchDoesNotSearchPluginMetadata);
    await runTest('Search "RunePouchPlacement" case-sensitive returns exactly 6 results', testSearchRunePouchPlacementCaseSensitive);
    await runTest('Search "RunePouchPlacement" case-insensitive returns exactly 7 results', testSearchRunePouchPlacementCaseInsensitive);
    
    console.log('\n' + '='.repeat(50));
    console.log(`Tests passed: ${TESTS_PASSED.length}`);
    console.log(`Tests failed: ${TESTS_FAILED.length}`);
    console.log('='.repeat(50));
    
    if (TESTS_FAILED.length > 0) {
        console.log('\nFailed tests:');
        for (const test of TESTS_FAILED) {
            console.error(`  - ${test.name}: ${test.error}`);
        }
        process.exit(1);
    } else {
        console.log('\nAll tests passed!');
        process.exit(0);
    }
}

runAllTests().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
