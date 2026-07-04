#!/usr/bin/env node
/**
 * Regression: the Monitor tab's focused RUN must survive a dashboard reopen.
 *
 * Farley review 2026-07-03, finding #3 (High): DashboardSelection persists
 * monitorAgentIndex but NOT monitorRunIndex, and the constructor never restores
 * it — so every reopen (which dashboard-orchestration does around any action)
 * silently resets the master-detail focus back to the first active run,
 * defeating the exact restore mechanism the selection object was built for.
 *
 * Contract pinned here (workflow-dashboard.ts):
 *   - "]" on the Monitor tab cycles the focused run (existing behavior).
 *   - getSelection() carries monitorRunIndex.
 *   - Rebuilding with restore keeps the focused run (and clamps it to the fresh
 *     model list, falling back safely when runs disappeared).
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const { check, counts } = createChecker();

const theme = { fg: (_c, v) => v };

function makeRun(runId, workflow) {
	return {
		workflow,
		scope: "project",
		runId,
		runDir: `/tmp/${runId}`,
		state: "running",
		background: true,
		startedAt: "2026-07-03T00:00:00.000Z",
		updatedAt: "2026-07-03T00:00:01.000Z",
		elapsedMs: 1000,
		agentCount: 1,
		logs: [],
	};
}

function makeAgent(id) {
	return {
		id,
		name: `agent-${id}`,
		state: "running",
		startedAt: "2026-07-03T00:00:00.000Z",
	};
}

function makeModel(runId, workflow) {
	const run = makeRun(runId, workflow);
	return {
		run,
		workflow,
		state: "running",
		active: true,
		stale: false,
		elapsedMs: 60000,
		agentsStarted: 2,
		agentsDone: 1,
		parallelAgents: 1,
		peakParallelAgents: 2,
		agentConcurrency: 4,
		bashDone: 0,
		artifactCount: 0,
		agents: [makeAgent(1), makeAgent(2)],
		runDir: run.runDir,
		priority: "active",
		canCancel: true,
		canRerun: false,
	};
}

function build(WorkflowDashboard, models, restore) {
	return new WorkflowDashboard(
		[],
		models.map((m) => m.run),
		[],
		[],
		models,
		models.map((m) => ({ run: m.run, agent: m.agents[0] })),
		theme,
		() => {},
		() => {},
		"monitor",
		restore,
	);
}

const showing = (lines) => lines.find((l) => l.includes("showing"))?.trim() ?? "(no header)";

async function main() {
	const { url } = await buildExtension({
		name: "pi-dwf-monitor-focus-restore",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "workflow-dashboard.ts"),
		outName: "workflow-dashboard.mjs",
		stubs: { typebox: true, typeboxValue: true, ai: true, tui: true, sdk: (dir) => dir && "" },
	});
	const { WorkflowDashboard } = await loadModule(url);

	const models = [makeModel("run-aaa", "flow-a"), makeModel("run-bbb", "flow-b"), makeModel("run-ccc", "flow-c")];

	// Focus the second run with "]" (existing behavior).
	const first = build(WorkflowDashboard, models);
	first.handleInput("]");
	check(
		"']' cycles the focused run (showing 2/3)",
		showing(first.render(120)).includes("2/3"),
		showing(first.render(120)),
	);

	// The selection must carry the focused run…
	const sel = first.getSelection();
	check("getSelection carries monitorRunIndex", sel.monitorRunIndex === 1, JSON.stringify(sel));

	// …and a reopen with restore must keep it.
	const reopened = build(WorkflowDashboard, models, sel);
	check(
		"reopen restores the focused run (showing 2/3)",
		showing(reopened.render(120)).includes("2/3"),
		showing(reopened.render(120)),
	);

	// Clamp: restore with fewer runs than before falls back safely.
	const shrunk = build(WorkflowDashboard, [models[0]], { ...sel, monitorRunIndex: 5 });
	const shrunkLines = shrunk.render(120);
	check("restore clamps to the fresh model list (no crash)", Array.isArray(shrunkLines) && shrunkLines.length > 0);

	console.log(`\nTOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
