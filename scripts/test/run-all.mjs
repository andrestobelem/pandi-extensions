#!/usr/bin/env node
/**
 * Run all durable Pi package integration suites sequentially.
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

// Explicit manifest by design: this runner should be stable even while another
// session is drafting a new `*.test.mjs` file in a suite directory. Add a suite here
// once it is expected to be green as part of the durable behavioral suite.
const suites = [
	"extensions/pi-auto-compact-context/tests/integration/auto-compact-context.test.mjs",
	"extensions/pi-bg/tests/integration/bg-extension.test.mjs",
	"extensions/pi-bg/tests/integration/bg-jobs.test.mjs",
	"extensions/pi-dynamic-workflows/tests/integration/composition-graph-expansion.test.mjs",
	"extensions/pi-dynamic-workflows/tests/integration/composition-rank.test.mjs",
	"extensions/pi-dynamic-workflows/tests/integration/dashboard-usability-fixes.test.mjs",
	"extensions/pi-dynamic-workflows/tests/integration/dynamic-workflow-composition.test.mjs",
	"extensions/pi-dynamic-workflows/tests/integration/editor-left-agents.test.mjs",
	"extensions/pi-dynamic-workflows/tests/integration/model-thinking-selection.test.mjs",
	"extensions/pi-dynamic-workflows/tests/integration/project-workflows-loadable.test.mjs",
	"extensions/pi-dynamic-workflows/tests/integration/prompt-catalog-single-source.test.mjs",
	"extensions/pi-dynamic-workflows/tests/integration/scaffold-synthesis-payload.test.mjs",
	"extensions/pi-dynamic-workflows/tests/integration/ultracode-border-status.test.mjs",
	"extensions/pi-dynamic-workflows/tests/integration/ultracode-contract-gate.test.mjs",
	"extensions/pi-dynamic-workflows/tests/integration/workflow-input-coercion.test.mjs",
	"extensions/pi-effort/tests/integration/effort-extension.test.mjs",
	"extensions/pi-goal/tests/integration/goal-rehydrate.test.mjs",
	"extensions/pi-goal/tests/integration/goal-verifier.test.mjs",
	"extensions/pi-loop/tests/integration/loop-behavior.test.mjs",
	"extensions/pi-loop/tests/integration/loop-caps-resume.test.mjs",
	"extensions/pi-loop/tests/integration/loop-safety.test.mjs",
	"extensions/pi-local-memory/tests/integration/local-memory.test.mjs",
	"extensions/pi-mdview/tests/integration/mdview-extension.test.mjs",
	"extensions/pi-mdview/tests/integration/mdview-tool.test.mjs",
	"extensions/pi-plan/tests/integration/plan-approval.test.mjs",
	"extensions/pi-plan/tests/integration/plan-gate.test.mjs",
	"extensions/pi-worktree/tests/integration/worktree-extension.test.mjs",
];

// Draft suites are intentionally excluded but must be explicit so `run-all` never
// silently misses a new durable suite. Remove from this set when the suite is
// expected to be green in the full behavioral run.
const ignoredDraftSuites = new Set([
	"extensions/pi-dynamic-workflows/tests/integration/composition-failure-recursion.test.mjs",
]);

const suiteDirs = [
	"extensions/pi-auto-compact-context/tests/integration",
	"extensions/pi-bg/tests/integration",
	"extensions/pi-dynamic-workflows/tests/integration",
	"extensions/pi-effort/tests/integration",
	"extensions/pi-goal/tests/integration",
	"extensions/pi-loop/tests/integration",
	"extensions/pi-local-memory/tests/integration",
	"extensions/pi-mdview/tests/integration",
	"extensions/pi-plan/tests/integration",
	"extensions/pi-worktree/tests/integration",
];

for (const suite of suites) {
	if (!fs.existsSync(path.join(REPO_ROOT, suite))) {
		console.error(`Missing integration suite from manifest: ${suite}`);
		process.exit(1);
	}
}

const discoveredSuites = suiteDirs.flatMap((dir) => {
	const abs = path.join(REPO_ROOT, dir);
	if (!fs.existsSync(abs)) return [];
	return fs
		.readdirSync(abs)
		.filter((name) => name.endsWith(".test.mjs"))
		.map((name) => path.posix.join(dir, name));
}).sort();
const unlistedSuites = discoveredSuites.filter((suite) => !suites.includes(suite) && !ignoredDraftSuites.has(suite));
if (unlistedSuites.length) {
	console.error("Unlisted integration suite(s) found. Add them to `suites` or `ignoredDraftSuites` with a reason:");
	for (const suite of unlistedSuites) console.error(`- ${suite}`);
	process.exit(1);
}

if (args.has("--list")) {
	for (const suite of suites) console.log(suite);
	for (const suite of ignoredDraftSuites) {
		if (fs.existsSync(path.join(REPO_ROOT, suite))) console.log(`# ignored draft: ${suite}`);
	}
	process.exit(0);
}

if (suites.length === 0) {
	console.error("No integration suites found in the manifest");
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
