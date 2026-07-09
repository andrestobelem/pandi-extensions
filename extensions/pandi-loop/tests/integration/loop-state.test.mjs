/**
 * Tests chicos para el modelo puro de estado de `pandi-loop`.
 *
 * Fijan la factory/snapshot antes de extraerlas de index.ts: el engine completo sigue
 * cubierto por las suites de comportamiento, pero estas aserciones hacen visible qué
 * campos pertenecen al estado persistible y cuáles son runtime-only.
 *
 * Ejecutarlo:
 *   node extensions/pandi-loop/tests/integration/loop-state.test.mjs
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle, createChecker, loadModule, makeBuildDir } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildState() {
	const { outDir, aliases } = await makeBuildDir("pi-loop-state");
	const url = await bundle({
		src: path.join(REPO_ROOT, "extensions", "pandi-loop", "state.ts"),
		outDir,
		outName: "state.mjs",
		aliases,
	});
	return { url };
}

function same(label, actual, expected) {
	check(label, JSON.stringify(actual) === JSON.stringify(expected), `actual=${JSON.stringify(actual)}`);
}

async function stateContract(url) {
	const mod = await loadModule(url);
	const {
		DEFAULT_CONTEXT_PERCENT_CAP,
		DEFAULT_MAX_ITERATIONS,
		DEFAULT_MAX_WALL_CLOCK_MS,
		createActiveLoop,
		positiveOr,
		shouldRehydrateLoopForSession,
		snapshot,
	} = mod;

	check("defaults: maxIterations stays 25", DEFAULT_MAX_ITERATIONS === 25);
	check("defaults: wall-clock cap stays 6h", DEFAULT_MAX_WALL_CLOCK_MS === 6 * 60 * 60 * 1000);
	check("defaults: context cap stays 90", DEFAULT_CONTEXT_PERCENT_CAP === 90);

	const now = Date.UTC(2026, 0, 2, 3, 4, 5);
	const loop = createActiveLoop({
		loopId: "loop-a",
		task: "watch build",
		intervalMs: undefined,
		now,
		ultracode: true,
		ownerSessionId: "session-a",
	});
	check("factory: creates an AbortController", loop.controller instanceof AbortController);
	same(
		"factory: dynamic loop state",
		{
			loopId: loop.loopId,
			task: loop.task,
			mode: loop.mode,
			intervalMs: loop.intervalMs,
			iteration: loop.iteration,
			maxIterations: loop.maxIterations,
			maxWallClockMs: loop.maxWallClockMs,
			contextPercentCap: loop.contextPercentCap,
			startedAt: loop.startedAt,
			nextFireAt: loop.nextFireAt,
			lastReason: loop.lastReason,
			status: loop.status,
			autonomous: loop.autonomous,
			ultracode: loop.ultracode,
			ownerSessionId: loop.ownerSessionId,
			updatedAt: loop.updatedAt,
			timer: loop.timer,
			rearmedThisTurn: loop.rearmedThisTurn,
			autopilot: loop.autopilot,
		},
		{
			loopId: "loop-a",
			task: "watch build",
			mode: "dynamic",
			iteration: 0,
			maxIterations: 25,
			maxWallClockMs: 21600000,
			contextPercentCap: 90,
			startedAt: now,
			nextFireAt: null,
			status: "running",
			ultracode: true,
			ownerSessionId: "session-a",
			updatedAt: new Date(now).toISOString(),
			timer: null,
			rearmedThisTurn: false,
			autopilot: false,
		},
	);

	const fixed = createActiveLoop({
		loopId: "loop-b",
		task: "watch deploy",
		intervalMs: 300000,
		now,
		autonomous: true,
		ultracode: false,
		ownerSessionId: "session-b",
	});
	same(
		"factory: fixed autonomous loop state",
		{
			mode: fixed.mode,
			intervalMs: fixed.intervalMs,
			autonomous: fixed.autonomous,
			ultracode: fixed.ultracode,
			ownerSessionId: fixed.ownerSessionId,
		},
		{
			mode: "fixed",
			intervalMs: 300000,
			autonomous: true,
			ultracode: false,
			ownerSessionId: "session-b",
		},
	);

	fixed.timer = setTimeout(() => {}, 1);
	fixed.autopilot = true;
	fixed.rearmedThisTurn = true;
	fixed.fixedAnchor = now + 1000;
	fixed.pausedRemainingMs = 123;
	fixed.lastReason = "testing snapshot";
	fixed.nextFireAt = now + 300000;
	const snap = snapshot(fixed);
	clearTimeout(fixed.timer);
	same("snapshot: keeps durable fields only", snap, {
		loopId: "loop-b",
		task: "watch deploy",
		mode: "fixed",
		intervalMs: 300000,
		iteration: 0,
		maxIterations: 25,
		maxWallClockMs: 21600000,
		contextPercentCap: 90,
		startedAt: now,
		nextFireAt: now + 300000,
		lastReason: "testing snapshot",
		status: "running",
		autonomous: true,
		ultracode: false,
		ownerSessionId: "session-b",
		updatedAt: new Date(now).toISOString(),
	});
	check("snapshot: omits runtime timer", !("timer" in snap));
	check("snapshot: omits runtime autopilot", !("autopilot" in snap));
	check("snapshot: omits pausedRemainingMs", !("pausedRemainingMs" in snap));

	const { fromSnapshot } = mod;
	const recovered = fromSnapshot(snap, "paused");
	check("fromSnapshot: applies status override", recovered.status === "paused");
	check("fromSnapshot: creates a fresh AbortController", recovered.controller instanceof AbortController);
	check("fromSnapshot: resets timer", recovered.timer === null);
	check("fromSnapshot: resets autopilot", recovered.autopilot === false);
	check("fromSnapshot: resets rearmedThisTurn", recovered.rearmedThisTurn === false);
	check("fromSnapshot: keeps durable loopId", recovered.loopId === "loop-b");
	check("fromSnapshot: keeps durable intervalMs", recovered.intervalMs === 300000);

	const legacy = fromSnapshot(
		{
			loopId: "legacy",
			task: "old",
			iteration: 3,
			startedAt: now,
			nextFireAt: null,
			status: "stale",
			updatedAt: undefined,
			// Snapshots viejos pueden omitir mode/caps o traer valores inválidos.
			maxIterations: 0,
			maxWallClockMs: -1,
			contextPercentCap: 150,
		},
		"running",
	);
	check("fromSnapshot: defaults missing mode to dynamic", legacy.mode === "dynamic");
	check("fromSnapshot: defaults invalid maxIterations", legacy.maxIterations === DEFAULT_MAX_ITERATIONS);
	check("fromSnapshot: defaults invalid maxWallClockMs", legacy.maxWallClockMs === DEFAULT_MAX_WALL_CLOCK_MS);
	check("fromSnapshot: clamps contextPercentCap to 100", legacy.contextPercentCap === 100);
	check("fromSnapshot: fills missing updatedAt", typeof legacy.updatedAt === "string" && legacy.updatedAt.length > 0);

	check("positiveOr: keeps finite positive numbers", positiveOr(7, 25) === 7);
	check("positiveOr: rejects zero", positiveOr(0, 25) === 25);
	check("positiveOr: rejects NaN", positiveOr(Number.NaN, 25) === 25);
	check("positiveOr: rejects non-numbers", positiveOr("7", 25) === 25);

	check("owner: matching owner rehydrates", shouldRehydrateLoopForSession(snap, "session-b", false) === true);
	check("owner: foreign owner is skipped", shouldRehydrateLoopForSession(snap, "session-a", false) === false);
	check(
		"owner: legacy JSONL entry rehydrates",
		shouldRehydrateLoopForSession({ ...snap, ownerSessionId: undefined }, "session-x", true) === true,
	);
	check(
		"owner: legacy sidecar-only state is skipped",
		shouldRehydrateLoopForSession({ ...snap, ownerSessionId: undefined }, "session-x", false) === false,
	);
}

async function main() {
	const { url } = await buildState();
	await stateContract(url);

	console.log("");
	console.log(`TOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		console.log("FAILURES:");
		for (const f of counts.failures) console.log(`  - ${f}`);
		process.exit(1);
	}
	process.exit(0);
}

main().catch((err) => {
	console.error("INTEGRATION TEST CRASH:", err?.stack ? err.stack : err);
	process.exit(2);
});
