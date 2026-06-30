#!/usr/bin/env node
/**
 * Contract tests for the dashboard data layer (dashboard-collectors.ts) — the read side
 * the Monitor renders. Locks in two exported, behavior-critical helpers that had no direct
 * coverage while workflow-dashboard.ts is under active refactor:
 *
 *   - collectWorkflowActivity(runs, maxRuns, maxEntries): the activity feed. Folds each
 *     run's inline logs (no disk read when `logs` is non-empty) into entries, keeps only
 *     the last 20 per run, sorts newest-first by `time`, caps to maxEntries, and carries
 *     `details` ONLY when defined (so the spread never injects `details: undefined`).
 *   - canRerunRun(run): gates the rerun action — true only when the run is NOT running AND
 *     its workflow `file` still exists on disk.
 *
 * Deterministic + offline: activity records carry inline `logs` so collectWorkflowActivity
 * never touches the run dir; canRerunRun is exercised against a real temp file. We bundle
 * dashboard-collectors.ts (which transitively pulls index.ts) with the standard stubs.
 *
 * Run it:
 *   node extensions/pi-dynamic-workflows/tests/integration/dashboard-collectors-contract.test.mjs
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const { check, counts } = createChecker();

async function loadModule() {
	const { url } = await buildExtension({
		name: "pi-dwf-dashboard-collectors",
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "dashboard-collectors.ts"),
		outName: "dashboard-collectors.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
		npx: "--yes",
	});
	return await import(url);
}

// A plain run record WITHOUT an "ok" key, so getRunState returns run.state verbatim and
// getRunLogs returns the inline logs (collectWorkflowActivity then never reads the run dir).
const run = (runId, workflow, state, logs) => ({ runId, workflow, state, runDir: "/does/not/exist", logs });
const log = (time, message, details) => (details === undefined ? { time, message } : { time, message, details });

async function main() {
	const { collectWorkflowActivity, canRerunRun } = await loadModule();

	// 1) Newest-first ordering across runs, with run-level fields carried through.
	const ordered = await collectWorkflowActivity([
		run("r1", "alpha", "running", [log("2026-01-01T00:00:01Z", "a-old"), log("2026-01-01T00:00:03Z", "a-new")]),
		run("r2", "beta", "completed", [log("2026-01-01T00:00:02Z", "b-mid")]),
	]);
	check(
		"activity: sorted newest-first by time across runs",
		ordered.map((e) => e.message).join(",") === "a-new,b-mid,a-old",
		ordered.map((e) => e.message).join(","),
	);
	check(
		"activity: carries runId/workflow/state from the run (not the log)",
		ordered[0].runId === "r1" && ordered[0].workflow === "alpha" && ordered[0].state === "running",
	);

	// 2) details is included ONLY when defined (spread must not inject details:undefined).
	const withDetails = await collectWorkflowActivity([
		run("r1", "alpha", "running", [
			log("2026-01-01T00:00:02Z", "has-details", { k: 1 }),
			log("2026-01-01T00:00:01Z", "no-details"),
		]),
	]);
	const hasOne = withDetails.find((e) => e.message === "has-details");
	const hasNone = withDetails.find((e) => e.message === "no-details");
	check("activity: keeps details when defined", "details" in hasOne && hasOne.details.k === 1);
	check("activity: omits the details key entirely when undefined", !("details" in hasNone));

	// 3) Per-run cap = last 20 log entries (the 25-entry run drops its 5 oldest).
	const many = Array.from({ length: 25 }, (_, i) =>
		// zero-padded index in BOTH time and message so lexical time order matches numeric order.
		log(`2026-01-02T00:00:${String(i).padStart(2, "0")}Z`, `m${String(i).padStart(2, "0")}`),
	);
	const capped = await collectWorkflowActivity([run("r1", "alpha", "running", many)]);
	check("activity: keeps at most the last 20 entries per run", capped.length === 20, `len=${capped.length}`);
	check(
		"activity: dropped the 5 OLDEST entries (m00..m04 absent, m24 present)",
		!capped.some((e) => e.message === "m04") && capped.some((e) => e.message === "m24"),
	);

	// 4) maxEntries caps the global result to the N newest after sorting.
	const limited = await collectWorkflowActivity(
		[
			run("r1", "alpha", "running", [
				log("2026-01-03T00:00:01Z", "x1"),
				log("2026-01-03T00:00:02Z", "x2"),
				log("2026-01-03T00:00:03Z", "x3"),
			]),
		],
		12,
		2,
	);
	check(
		"activity: maxEntries caps to the N newest",
		limited.length === 2 && limited.map((e) => e.message).join(",") === "x3,x2",
		limited.map((e) => e.message).join(","),
	);

	// 5) maxRuns caps how many runs are scanned (later runs ignored entirely).
	const scanned = await collectWorkflowActivity(
		[
			run("r1", "alpha", "running", [log("2026-01-04T00:00:01Z", "kept")]),
			run("r2", "beta", "running", [log("2026-01-04T00:00:09Z", "ignored")]),
		],
		1,
	);
	check(
		"activity: maxRuns limits scanned runs (second run skipped even if newer)",
		scanned.length === 1 && scanned[0].message === "kept",
		JSON.stringify(scanned.map((e) => e.message)),
	);

	// 6) Empty input → empty feed.
	check("activity: empty runs → []", (await collectWorkflowActivity([])).length === 0);

	// --- canRerunRun ---------------------------------------------------------
	const dir = mkdtempSync(path.join(os.tmpdir(), "dwf-rerun-"));
	const existing = path.join(dir, "wf.workflow.js");
	writeFileSync(existing, "export const meta = {};\n");
	const missing = path.join(dir, "gone.workflow.js");
	try {
		check("canRerun: running run is never rerunnable", canRerunRun({ state: "running", file: existing }) === false);
		check("canRerun: completed + existing file → true", canRerunRun({ state: "completed", file: existing }) === true);
		check("canRerun: completed + missing file → false", canRerunRun({ state: "completed", file: missing }) === false);
		check("canRerun: completed + no file recorded → false", canRerunRun({ state: "completed" }) === false);
		check(
			"canRerun: failed run with file → true (only running blocks)",
			canRerunRun({ state: "failed", file: existing }) === true,
		);
		check("canRerun: stale run with file → true", canRerunRun({ state: "stale", file: existing }) === true);
		// Guard the test's own premise: the temp file truly exists, the other truly does not.
		check(
			"canRerun: fixture sanity (existing present, missing absent)",
			existsSync(existing) && !existsSync(missing),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

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
