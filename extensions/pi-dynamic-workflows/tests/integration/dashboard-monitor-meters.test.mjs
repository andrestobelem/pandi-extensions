#!/usr/bin/env node
/**
 * Behavioral contract test for the Monitor tab's at-a-glance meters.
 *
 * The Monitor used to surface progress as bare numbers ("agents: 3/8 done/started",
 * "parallel: 2/4 running"). This pins the visual upgrade: those two lines now also carry
 * a unicode meter bar (renderMeter) so utilization is readable at a glance, and the
 * agents line carries a rounded completion percentage. The multi-run summary list (shown
 * when >1 run is active) gains a compact per-row meter too.
 *
 * Observable contract:
 *   - The agents line keeps "3/8" AND adds "38%" (3/8 = 37.5% → 38) AND a meter (█/░).
 *   - The parallel line keeps its running count AND adds a meter for running/limit.
 *   - With >1 active run, each summary row carries a meter.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

const theme = { fg: (_c, v) => v, bg: (_c, v) => v, bold: (v) => v };
const WIDTH = 10000;
const hasMeter = (s) => typeof s === "string" && s.includes("█") && s.includes("░");

function makeAgent() {
	return { id: 1, name: "scout", state: "running", elapsedMs: 4200, promptAvailable: true };
}

function makeRun(runId, workflow) {
	const now = Date.now();
	return {
		workflow,
		scope: "project",
		file: "/nonexistent/x.js",
		runId,
		runDir: "/tmp/nonexistent-run-dir",
		ok: true,
		state: "running",
		startedAt: new Date(now - 60000).toISOString(),
		elapsedMs: 60000,
		agentCount: 8,
		agentConcurrency: 4,
		parallelAgents: 2,
		peakParallelAgents: 3,
		logs: [],
	};
}

function makeMonitorModel(run, agent, overrides = {}) {
	return {
		run,
		workflow: run.workflow,
		runId: run.runId,
		state: "running",
		active: true,
		stale: false,
		elapsedMs: 60000,
		agentsStarted: 8,
		agentsDone: 3,
		parallelAgents: 2,
		peakParallelAgents: 3,
		agentConcurrency: 4,
		bashDone: 0,
		artifactCount: 1,
		agents: [agent],
		runDir: run.runDir,
		priority: "active",
		canCancel: true,
		canRerun: false,
		...overrides,
	};
}

function build(models) {
	const run = models[0].run;
	return new WorkflowDashboard(
		[],
		[run],
		[],
		[],
		models,
		[{ run, agent: models[0].agents[0] }],
		theme,
		() => {},
		() => {},
		"monitor",
	);
}

let WorkflowDashboard;

async function main() {
	const { url } = await buildExtension({
		name: "pi-dwf-monitor-meters",
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "workflow-dashboard.ts"),
		outName: "workflow-dashboard.mjs",
		stubs: { typebox: true, typeboxValue: true, ai: true, tui: true, sdk: (dir) => dir && "" },
		npx: "--yes",
	});
	({ WorkflowDashboard } = await loadModule(url));

	// Single active run: detail block carries agents + parallel meters.
	const single = build([makeMonitorModel(makeRun("run-aaaaaaaaaaaa", "flow-a"), makeAgent())]).render(WIDTH);

	const agentsLine = single.find((l) => l.includes("done/started"));
	check("agents line exists", typeof agentsLine === "string", JSON.stringify(agentsLine));
	check("agents line keeps the n/m count", agentsLine?.includes("3/8"), JSON.stringify(agentsLine));
	check("agents line shows rounded percentage (38%)", agentsLine?.includes("38%"), JSON.stringify(agentsLine));
	check("agents line carries a meter", hasMeter(agentsLine), JSON.stringify(agentsLine));

	const parallelLine = single.find((l) => l.startsWith("parallel:") && l.includes("running"));
	check("parallel line exists", typeof parallelLine === "string", JSON.stringify(parallelLine));
	check("parallel line carries a meter", hasMeter(parallelLine), JSON.stringify(parallelLine));

	// Multiple active runs: each summary row carries a compact meter.
	const multi = build([
		makeMonitorModel(makeRun("run-aaaaaaaaaaaa", "flow-a"), makeAgent()),
		makeMonitorModel(makeRun("run-bbbbbbbbbbbb", "flow-b"), makeAgent(), { agentsDone: 6 }),
	]).render(WIDTH);
	const summaryRows = multi.filter((l) => l.includes("flow-a") || l.includes("flow-b")).filter(hasMeter);
	check("multi-run summary rows carry meters", summaryRows.length >= 2, `rows with meters=${summaryRows.length}`);

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
