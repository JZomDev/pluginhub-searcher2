import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { existsSync } from "node:fs";
import { BinaryIndexBuilder } from "../script/index-builder.js";
import { queryIndex, parseIndex } from "../script/search.js";
import { dirname, join } from "node:path";

const testDir = dirname(new URL(import.meta.url).pathname);
const projectRoot = join(testDir, "..");

const gzFilePath = join(projectRoot, "index/plugins.bin.gz");
const pluginGlob = join(projectRoot, "plugins/plugins_*.json");
const binFilePath = join(projectRoot, "index/plugins.bin");

async function buildTestIndex() {
    if (existsSync(gzFilePath)) {
        return true;
    }

    const builder = new BinaryIndexBuilder();
    const result = await builder.run(
        pluginGlob,
        binFilePath,
        gzFilePath,
        (current, total) => {
            process.stdout.write(`\rBuilding index: ${current}/${total}`);
        }
    );
    console.log("\nIndex built successfully:", {
        binarySize: result.binarySize,
        gzippedSize: result.gzippedSize,
        fileCount: result.fileCount,
        stringTableSize: result.stringTableSize
    });
    return true;
}

function countMatches(results) {
    let count = 0;
    for (const entry of Object.values(results)) {
        count += entry.matches.length;
    }
    return count;
}

test("search 'ZigZagLayoutConfig' returns 6 matches", async () => {
    await buildTestIndex();
    const results = await queryIndex(gzFilePath, "ZigZagLayoutConfig");

    const matches = countMatches(results);
    strictEqual(matches, 6, "Expected 6 matches for ZigZagLayoutConfig");

    ok(results["src/main/java/com/zom/ZigZagLayoutConfig.java"],
        "Should find ZigZagLayoutConfig.java");
    ok(results["src/main/java/com/zom/ZigZagLayoutPlugin.java"],
        "Should find ZigZagLayoutPlugin.java");

    console.log("ZigZagLayoutConfig matches found:", matches);
    for (const [file, entry] of Object.entries(results)) {
        console.log(`  File: ${file}`);
        for (const m of entry.matches) {
            console.log(`    Line ${m.line}: ${m.text}`);
        }
    }
});

test("search 'item != null' returns 2 matches", async () => {
    await buildTestIndex();
    const results = await queryIndex(gzFilePath, "item != null");

    const matches = countMatches(results);
    strictEqual(matches, 2, "Expected 2 matches for 'item != null'");
    console.log("'item != null' matches found:", matches);
});

test("search 'RunePouchPlacement' returns 6 matches", async () => {
    await buildTestIndex();
    const results = await queryIndex(gzFilePath, "RunePouchPlacement");

    const matches = countMatches(results);
    strictEqual(matches, 6, "Expected 6 matches for RunePouchPlacement");

    ok(results["src/main/java/com/zom/RunePouchPlacement.java"],
        "Should find RunePouchPlacement.java");
    ok(results["src/main/java/com/zom/ZigZagLayoutConfig.java"],
        "Should find ZigZagLayoutConfig.java");
    ok(results["src/main/java/com/zom/ZigZagLayoutPlugin.java"],
        "Should find ZigZagLayoutPlugin.java");

    console.log("RunePouchPlacement matches found:", matches);
});

// test("extractIdentifiers filters keywords correctly", () => {
//     const keywords = extractIdentifiers("public class MyClass { void foo() { String x; } }");
//     ok(!keywords.includes("class"), "Should exclude 'class' keyword");
//     ok(!keywords.includes("public"), "Should exclude 'public' keyword");
//     ok(!keywords.includes("void"), "Should exclude 'void' keyword");
//     ok(!keywords.includes("String"), "Should exclude 'String' keyword");
//     ok(keywords.includes("MyClass"), "Should include 'MyClass'");
//     ok(keywords.includes("foo"), "Should include 'foo'");
//     console.log("Identifiers extracted:", keywords);
// });

test("search returns empty results for non-existent term", async () => {
    await buildTestIndex();
    const results = await queryIndex(gzFilePath, "thisdefinitelydoesnotexist999");

    strictEqual(Object.keys(results).length, 0, "Expected 0 matches");
    console.log("Non-existent term returns empty results");
});
