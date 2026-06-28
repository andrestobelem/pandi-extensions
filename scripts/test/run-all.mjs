#!/usr/bin/env node
/**
 * Run all durable Pi package integration suites sequentially.
 *
 * Source of truth = DISCOVERY by convention: every
 * `extensions/<ext>/tests/integration/*.test.mjs` is run. Each extension brings its own
 * suites, so adding one needs no edit here — this runner only orchestrates + aggregates.
 * A suite that is not yet expected to be green is excluded ONLY by listing it explicitly
 * in `ignoredDraftSuites` (with a reason); nothing is ever skipped silently.
 *
 * `npm test` delegates here after typecheck. You can also run the behavioral
 * suite directly while iterating:
 *
 *   node scripts/test/run-all.mjs
 *   node scripts/test/run-all.mjs --list
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const allowedArgs = new Set(["--list"]);
const unknownArgs = rawArgs.filter((arg) => !allowedArgs.has(arg));
if (unknownArgs.length) {
	console.error(`Unknown argument(s): ${unknownArgs.join(", ")}`);
	console.error("Usage: node scripts/test/run-all.mjs [--list]");
	process.exit(1);
}

const SUITE_TIMEOUT_MS = 120_000;
const EXTENSIONS_DIR = "extensions";
const SUITE_SUBDIR = path.posix.join("tests", "integration");

// Draft suites are excluded but must be EXPLICIT (with a reason), so a not-yet-green
// suite is never run AND a green suite is never skipped silently. Promote a suite out
// of here once it is reliably green. Currently empty.
const ignoredDraftSuites = new Set([]);

// Discover suite directories by convention: extensions/<ext>/tests/integration that exist.
const extensionsDirAbs = path.join(REPO_ROOT, EXTENSIONS_DIR);
const suiteDirs = (fs.existsSync(extensionsDirAbs)
	? fs.readdirSync(extensionsDirAbs, { withFileTypes: true })
	: [])
	.filter((entry) => entry.isDirectory())
	.map((entry) => path.posix.join(EXTENSIONS_DIR, entry.name, SUITE_SUBDIR))
	.filter((dir) => fs.existsSync(path.join(REPO_ROOT, dir)))
	.sort();

// Discover suites: every *.test.mjs under those directories.
const discoveredSuites = suiteDirs
	.flatMap((dir) =>
		fs
			.readdirSync(path.join(REPO_ROOT, dir))
			.filter((name) => name.endsWith(".test.mjs"))
			.map((name) => path.posix.join(dir, name)),
	)
	.sort();

const suites = discoveredSuites.filter((suite) => !ignoredDraftSuites.has(suite));

if (args.has("--list")) {
	for (const suite of suites) console.log(suite);
	for (const suite of ignoredDraftSuites) {
		if (fs.existsSync(path.join(REPO_ROOT, suite))) console.log(`# ignored draft: ${suite}`);
	}
	process.exit(0);
}

if (suites.length === 0) {
	console.error("No integration suites discovered under extensions/*/tests/integration");
	process.exit(1);
}

const results = [];
for (const suite of suites) {
	const relative = suite;
	console.log(`\n=== ${relative} ===`);
	const started = Date.now();
	const result = spawnSync(process.execPath, [path.join(REPO_ROOT, suite)], {
		cwd: REPO_ROOT,
		stdio: "inherit",
		env: process.env,
		timeout: SUITE_TIMEOUT_MS,
		killSignal: "SIGTERM",
	});
	const elapsedMs = Date.now() - started;
	const timedOut = result.error?.code === "ETIMEDOUT";
	const status = typeof result.status === "number" ? result.status : 1;
	results.push({ suite: relative, status, elapsedMs, signal: result.signal, timedOut });
	console.log(`=== ${relative}: ${status === 0 ? "PASS" : timedOut ? "TIMEOUT" : "FAIL"} (${Math.round(elapsedMs / 1000)}s) ===`);
	if (result.error) console.error(result.error);
}

const failed = results.filter((result) => result.status !== 0);
console.log("\n=== integration summary ===");
for (const result of results) {
	const suffix = result.signal ? ` signal=${result.signal}` : "";
	const label = result.status === 0 ? "PASS" : result.timedOut ? "TIMEOUT" : "FAIL";
	console.log(`${label} ${result.suite} (${Math.round(result.elapsedMs / 1000)}s)${suffix}`);
}
console.log(`${results.length - failed.length}/${results.length} suites passed`);

process.exit(failed.length === 0 ? 0 : 1);
