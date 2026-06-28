#!/usr/bin/env node
/**
 * Behavioral integration test for pi-auto-compact-context.
 *
 * Focus: the edge-triggered compaction must fire ONCE on a genuine threshold
 * crossing and must NOT re-fire every turn when a completed compaction failed to
 * bring usage back below the threshold (the re-compaction loop).
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function build() {
	const { url } = await buildExtension({
		name: "pi-auto-compact-integration",
		src: path.join(REPO_ROOT, "extensions", "pi-auto-compact-context", "index.ts"),
		outName: "ac.mjs",
		npx: "--no-install",
	});
	return url;
}

async function loadExtension(url) {
	const extension = await loadDefault(url);
	const handlers = new Map();
	const commands = new Map();
	const pi = {
		on: (event, fn) => handlers.set(event, fn),
		registerCommand: (name, opts) => commands.set(name, opts),
	};
	extension(pi);
	return { handlers, commands };
}

/**
 * Fake ExtensionContext. `compact` increments a counter and, on completion,
 * applies `reduceTo` (if set) to the reported usage before invoking onComplete,
 * modelling a compaction that may or may not bring usage below the threshold.
 */
function makeEnv() {
	const notes = [];
	const state = { percent: 0, compactCount: 0, reduceTo: null };
	const ctx = {
		hasUI: true,
		ui: { notify: (m, l) => notes.push({ m, l }) },
		getContextUsage: () => ({ percent: state.percent }),
		compact: ({ onComplete }) => {
			state.compactCount += 1;
			queueMicrotask(() => {
				if (state.reduceTo !== null) state.percent = state.reduceTo;
				onComplete?.();
			});
		},
	};
	return { ctx, notes, state };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function fireAgentEnd(handlers, ctx) {
	await handlers.get("agent_end")?.(null, ctx);
	await tick(); // let queued compaction onComplete run
}

async function stuckAboveThresholdDoesNotLoop(url) {
	const { handlers } = await loadExtension(url);
	const env = makeEnv();
	// Compaction never reduces usage below the 30% default threshold.
	env.state.percent = 60;
	env.state.reduceTo = 60;

	await fireAgentEnd(handlers, env.ctx); // genuine crossing -> compaction #1
	await fireAgentEnd(handlers, env.ctx); // still 60% -> must NOT re-compact
	await fireAgentEnd(handlers, env.ctx); // still 60% -> must NOT re-compact

	check(
		"loop: compaction fires exactly once while usage stays above threshold",
		env.state.compactCount === 1,
		`compactCount=${env.state.compactCount}`,
	);
}

async function genuineRecrossRetriggers(url) {
	const { handlers } = await loadExtension(url);
	const env = makeEnv();
	// Compaction succeeds: brings usage down to 20% (below threshold).
	env.state.percent = 60;
	env.state.reduceTo = 20;

	await fireAgentEnd(handlers, env.ctx); // crossing -> compaction #1, now at 20%
	await fireAgentEnd(handlers, env.ctx); // 20% < 30% -> no compaction
	env.state.percent = 60; // genuine new rise above threshold
	env.state.reduceTo = 20;
	await fireAgentEnd(handlers, env.ctx); // crossing again -> compaction #2

	check(
		"recross: a genuine new threshold crossing re-triggers compaction",
		env.state.compactCount === 2,
		`compactCount=${env.state.compactCount}`,
	);
}

async function belowThresholdNeverCompacts(url) {
	const { handlers } = await loadExtension(url);
	const env = makeEnv();
	env.state.percent = 20; // never crosses 30%
	await fireAgentEnd(handlers, env.ctx);
	await fireAgentEnd(handlers, env.ctx);
	check("below: no compaction while under threshold", env.state.compactCount === 0, `compactCount=${env.state.compactCount}`);
}

// Pure unit-level coverage for parseThreshold (named export). Imports the
// bundled module directly; does not instantiate the extension.
async function parseThresholdEdgeCases(url) {
	const mod = await loadModule(url);
	const parseThreshold = mod.parseThreshold;
	check("parseThreshold: exported as a function", typeof parseThreshold === "function", `typeof=${typeof parseThreshold}`);
	if (typeof parseThreshold !== "function") return;

	const cases = [
		["50", 50],
		["50%", 50],
		["0", undefined], // <= 0 rejected
		["100", undefined], // >= 100 rejected
		["", undefined],
		[undefined, undefined],
		["abc", undefined], // NaN rejected
		[" 75 ", 75], // trimmed
	];
	for (const [input, expected] of cases) {
		const actual = parseThreshold(input);
		check(`parseThreshold(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`, actual === expected, `got ${JSON.stringify(actual)}`);
	}
}

async function main() {
	const url = await build();
	await stuckAboveThresholdDoesNotLoop(url);
	await genuineRecrossRetriggers(url);
	await belowThresholdNeverCompacts(url);
	await parseThresholdEdgeCases(url);

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.error(counts.failures.join("\n"));
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err?.stack || err);
	process.exit(1);
});
