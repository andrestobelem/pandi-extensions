#!/usr/bin/env node
/**
 * Run all durable Pi dynamic-workflows e2e suites sequentially.
 *
 * This intentionally stays outside `npm test` so it does not change the package's
 * typecheck-only contract. Use it when you want the behavioral suite:
 *
 *   node examples/e2e/run-all.mjs
 *   node examples/e2e/run-all.mjs --list
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
	console.error("Usage: node examples/e2e/run-all.mjs [--list]");
	process.exit(1);
}

const SUITE_TIMEOUT_MS = 120_000;

// Explicit manifest by design: this runner should be stable even while another
// session is drafting a new `*.e2e.mjs` file in this directory. Add a suite here
// once it is expected to be green as part of the durable behavioral suite.
const suites = [
	"composition-graph-expansion.e2e.mjs",
	"composition-rank.e2e.mjs",
	"dynamic-workflow-composition.e2e.mjs",
	"goal-rehydrate.e2e.mjs",
	"goal-verifier.e2e.mjs",
	"loop-behavior.e2e.mjs",
	"loop-caps-resume.e2e.mjs",
	"plan-approval.e2e.mjs",
	"safety-gates.e2e.mjs",
];

// Draft suites are intentionally excluded but must be explicit so `run-all` never
// silently misses a new durable suite. Remove from this set when the suite is
// expected to be green in the full behavioral run.
const ignoredDraftSuites = new Set([
	"composition-failure-recursion.e2e.mjs",
]);

for (const suite of suites) {
	if (!fs.existsSync(path.join(__dirname, suite))) {
		console.error(`Missing e2e suite from manifest: examples/e2e/${suite}`);
		process.exit(1);
	}
}

const discoveredSuites = fs
	.readdirSync(__dirname)
	.filter((name) => name.endsWith(".e2e.mjs"))
	.sort();
const unlistedSuites = discoveredSuites.filter((suite) => !suites.includes(suite) && !ignoredDraftSuites.has(suite));
if (unlistedSuites.length) {
	console.error("Unlisted e2e suite(s) found. Add them to `suites` or `ignoredDraftSuites` with a reason:");
	for (const suite of unlistedSuites) console.error(`- examples/e2e/${suite}`);
	process.exit(1);
}

if (args.has("--list")) {
	for (const suite of suites) console.log(path.posix.join("examples/e2e", suite));
	for (const suite of ignoredDraftSuites) {
		if (fs.existsSync(path.join(__dirname, suite))) console.log(`# ignored draft: ${path.posix.join("examples/e2e", suite)}`);
	}
	process.exit(0);
}

if (suites.length === 0) {
	console.error("No e2e suites found in examples/e2e/*.e2e.mjs");
	process.exit(1);
}

const results = [];
for (const suite of suites) {
	const relative = path.posix.join("examples/e2e", suite);
	console.log(`\n=== ${relative} ===`);
	const started = Date.now();
	const result = spawnSync(process.execPath, [path.join(__dirname, suite)], {
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
console.log("\n=== e2e summary ===");
for (const result of results) {
	const suffix = result.signal ? ` signal=${result.signal}` : "";
	const label = result.status === 0 ? "PASS" : result.timedOut ? "TIMEOUT" : "FAIL";
	console.log(`${label} ${result.suite} (${Math.round(result.elapsedMs / 1000)}s)${suffix}`);
}
console.log(`${results.length - failed.length}/${results.length} suites passed`);

process.exit(failed.length === 0 ? 0 : 1);
