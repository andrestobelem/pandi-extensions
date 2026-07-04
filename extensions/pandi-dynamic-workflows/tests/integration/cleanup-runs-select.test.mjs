#!/usr/bin/env node
/**
 * Contract test for the run-cleanup SELECTION policy (run-state.ts, selectRunsForCleanup).
 *
 * `/workflow cleanup runs` must be safe by construction: it deletes only TERMINAL run
 * directories and never a run that is still running or tracked as active in-memory, and it
 * always retains the `keep` most-recent runs so a bulk cleanup can't wipe the freshest
 * history. The IO wrapper (run-lifecycle.ts, cleanupWorkflowRuns) does the actual `fs.rm`;
 * this pins the pure decision so a future refactor of the wrapper can't silently start
 * selecting a running/active run or dropping the retention window.
 *
 * Pure + offline: bundles run-state.ts (type-only dep on index.ts) with standard stubs and
 * calls the exported selector in memory. No run dirs are touched.
 *
 * Run it:
 *   node extensions/pandi-dynamic-workflows/tests/integration/cleanup-runs-select.test.mjs
 */
import * as path from "node:path";
import { buildExtension, createChecker, REPO_ROOT } from "../../../shared/test/harness.mjs";

const { check, counts } = createChecker();

async function loadModule() {
	const { url } = await buildExtension({
		name: "pi-dwf-cleanup-runs-select",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "run-state.ts"),
		outName: "run-state.mjs",
		stubs: { typebox: true, typeboxValue: true, ai: true, tui: true, sdk: (dir) => dir && "" },
	});
	return await import(url);
}

// A run record WITHOUT an "ok" key so getRunState returns run.state verbatim.
const run = (runId, state, startedAt) => ({
	runId,
	workflow: "drafts/x",
	state,
	startedAt,
	runDir: `/runs/${runId}`,
});
const ids = (runs) => runs.map((r) => r.runId);

async function main() {
	const { selectRunsForCleanup } = await loadModule();
	check("exports selectRunsForCleanup", typeof selectRunsForCleanup === "function", typeof selectRunsForCleanup);

	const empty = new Set();

	// 1) running is NEVER selected, even beyond the keep window.
	{
		const runs = [
			run("r5", "running", "2026-06-01T00:00:05Z"),
			run("r4", "completed", "2026-06-01T00:00:04Z"),
			run("r3", "failed", "2026-06-01T00:00:03Z"),
			run("r2", "cancelled", "2026-06-01T00:00:02Z"),
			run("r1", "stale", "2026-06-01T00:00:01Z"),
		];
		const selected = selectRunsForCleanup(runs, { keep: 0, activeIds: empty });
		check("running never selected", !ids(selected).includes("r5"), JSON.stringify(ids(selected)));
		check(
			"all four terminal states selectable with keep=0",
			["r1", "r2", "r3", "r4"].every((id) => ids(selected).includes(id)),
			JSON.stringify(ids(selected)),
		);
	}

	// 2) activeIds are never selected even if their state looks terminal.
	{
		const runs = [run("a1", "failed", "2026-06-01T00:00:02Z"), run("a2", "completed", "2026-06-01T00:00:01Z")];
		const selected = selectRunsForCleanup(runs, { keep: 0, activeIds: new Set(["a1"]) });
		check("active id excluded", !ids(selected).includes("a1"), JSON.stringify(ids(selected)));
		check("non-active terminal included", ids(selected).includes("a2"), JSON.stringify(ids(selected)));
	}

	// 3) keep=N retains the N most-recent (by startedAt desc); older terminal runs are selected.
	{
		const runs = [
			run("old1", "completed", "2026-06-01T00:00:01Z"),
			run("old2", "completed", "2026-06-01T00:00:02Z"),
			run("new1", "completed", "2026-06-01T00:00:03Z"),
			run("new2", "completed", "2026-06-01T00:00:04Z"),
		];
		const selected = selectRunsForCleanup(runs, { keep: 2, activeIds: empty });
		check(
			"keep=2 selects the 2 oldest",
			ids(selected).sort().join(",") === "old1,old2",
			JSON.stringify(ids(selected)),
		);
		check(
			"keep=2 retains the 2 newest",
			!ids(selected).some((id) => id.startsWith("new")),
			JSON.stringify(ids(selected)),
		);
	}

	// 4) state filter restricts selection to the requested states (still honoring keep).
	{
		const runs = [
			run("c1", "completed", "2026-06-01T00:00:03Z"),
			run("f1", "failed", "2026-06-01T00:00:02Z"),
			run("x1", "cancelled", "2026-06-01T00:00:01Z"),
		];
		const selected = selectRunsForCleanup(runs, { keep: 0, states: ["failed", "cancelled"], activeIds: empty });
		check(
			"state filter keeps only failed+cancelled",
			ids(selected).sort().join(",") === "f1,x1",
			JSON.stringify(ids(selected)),
		);
	}

	// 5) empty input → empty selection.
	check("empty input → []", selectRunsForCleanup([], { keep: 0, activeIds: empty }).length === 0);

	// 6) keep larger than the terminal count → nothing selected.
	{
		const runs = [run("t1", "completed", "2026-06-01T00:00:01Z"), run("t2", "failed", "2026-06-01T00:00:02Z")];
		check("keep >= count → []", selectRunsForCleanup(runs, { keep: 5, activeIds: empty }).length === 0);
	}

	if (counts.failed > 0) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
