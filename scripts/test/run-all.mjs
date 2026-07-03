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

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const allowedArgs = new Set(["--list", "--serial"]);
const unknownArgs = rawArgs.filter((arg) => !allowedArgs.has(arg));
if (unknownArgs.length) {
	console.error(`Unknown argument(s): ${unknownArgs.join(", ")}`);
	console.error("Usage: node scripts/test/run-all.mjs [--list] [--serial]");
	process.exit(1);
}

const SUITE_TIMEOUT_MS = 120_000;
const SUITE_KILL_GRACE_MS = 5_000;
// Suites are process-isolated (own tempdir + child + cache-busted import), so they run in a bounded
// parallel pool for fast feedback. Cap conservatively (default min(cpus,4)) to limit CPU contention
// that could destabilize the few timing-sensitive suites; override with TEST_CONCURRENCY or --serial.
const CONCURRENCY = args.has("--serial")
	? 1
	: Math.max(1, Number(process.env.TEST_CONCURRENCY) || Math.min(4, os.cpus().length || 4));
const EXTENSIONS_DIR = "extensions";
const SUITE_SUBDIR = path.posix.join("tests", "integration");

// Draft suites are excluded but must be EXPLICIT (with a reason), so a not-yet-green
// suite is never run AND a green suite is never skipped silently. Promote a suite out
// of here once it is reliably green. Currently empty.
const ignoredDraftSuites = new Set([]);

// Discover suite directories by convention: extensions/<ext>/tests/integration that exist.
const extensionsDirAbs = path.join(REPO_ROOT, EXTENSIONS_DIR);
const suiteDirs = (fs.existsSync(extensionsDirAbs) ? fs.readdirSync(extensionsDirAbs, { withFileTypes: true }) : [])
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

// Run one suite in a child process, buffering its output (parallel-safe, unlike live `inherit`).
// Preserves the timeout+SIGTERM semantics of the old spawnSync path, with a SIGKILL fallback.
function runSuite(suite) {
	return new Promise((resolve) => {
		const started = Date.now();
		let out = "";
		let timedOut = false;
		let killTimer = null;
		const child = spawn(process.execPath, [path.join(REPO_ROOT, suite)], { cwd: REPO_ROOT, env: process.env });
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), SUITE_KILL_GRACE_MS);
		}, SUITE_TIMEOUT_MS);
		child.stdout.on("data", (d) => {
			out += d;
		});
		child.stderr.on("data", (d) => {
			out += d;
		});
		const done = (status, signal, errText) => {
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			resolve({ suite, status, elapsedMs: Date.now() - started, signal, timedOut, out: out + (errText || "") });
		};
		child.on("close", (code, signal) => done(typeof code === "number" ? code : 1, signal));
		child.on("error", (err) => done(1, null, `\n${err}`));
	});
}

// Bounded worker pool: at most CONCURRENCY suites in flight; results kept in suite order.
const results = new Array(suites.length);
let nextIndex = 0;
async function worker() {
	while (nextIndex < suites.length) {
		const i = nextIndex++;
		const suite = suites[i];
		const result = await runSuite(suite);
		results[i] = result;
		const label = result.status === 0 ? "PASS" : result.timedOut ? "TIMEOUT" : "FAIL";
		// Print each suite's buffered output as one coherent block when it finishes.
		process.stdout.write(`\n=== ${suite}: ${label} (${Math.round(result.elapsedMs / 1000)}s) ===\n`);
		if (result.out) process.stdout.write(result.out.endsWith("\n") ? result.out : `${result.out}\n`);
	}
}

console.log(`Running ${suites.length} suites, concurrency ${CONCURRENCY}...`);
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, suites.length) }, () => worker()));

const failed = results.filter((result) => result.status !== 0);
console.log("\n=== integration summary ===");
for (const result of results) {
	const suffix = result.signal ? ` signal=${result.signal}` : "";
	const label = result.status === 0 ? "PASS" : result.timedOut ? "TIMEOUT" : "FAIL";
	console.log(`${label} ${result.suite} (${Math.round(result.elapsedMs / 1000)}s)${suffix}`);
}
console.log(`${results.length - failed.length}/${results.length} suites passed`);

process.exit(failed.length === 0 ? 0 : 1);
