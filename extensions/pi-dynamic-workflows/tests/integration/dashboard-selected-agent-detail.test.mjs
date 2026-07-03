#!/usr/bin/env node
/**
 * Behavioral contract test for the shared "Selected agent" detail block.
 *
 * The Monitor tab (renderMonitorAgents) and the Agents tab (renderAgents) both render a
 * "Selected agent" detail section for the focused agent. That section used to be a
 * near-identical copy in each method; it is now produced by one private helper
 * (renderSelectedAgentDetail), parameterized by the only intended differences:
 *
 *   - Agents prepends a workflow/run/parallel header; Monitor does not.
 *   - Agents appends a "• schema …" suffix on the `state:` line; Monitor does not.
 *   - prompt preview / output use compactInline width 260 (Agents) vs 220 (Monitor).
 *
 * This test pins the OBSERVABLE contract that previously had no coverage: for an
 * equivalent agent, every NON-differing detail line (agent/phase/prompt/tools/skills/
 * extensions/keys) is byte-identical across both tabs, while the three intended
 * differences are preserved. It guards against the two copies silently diverging
 * (e.g. a future edit touching only one tab's field formatting).
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

const theme = { fg: (_c, v) => v, bg: (_c, v) => v, bold: (v) => v };
const WIDTH = 10000; // wide enough that truncateToWidth never trims; only compactInline does

function makeAgent() {
	return {
		id: 1,
		name: "scout",
		state: "completed",
		elapsedMs: 4200,
		code: 0,
		schemaOk: true,
		promptAvailable: true,
		artifactPath: "agent-1/output.md",
		tools: ["read", "grep"],
		excludeTools: ["bash"],
		skills: ["karpathy"],
		includeSkills: true,
		extensions: ["pi-loop"],
		includeExtensions: false,
		keys: ["OPENAI_API_KEY"],
		missingKeys: ["ANTHROPIC_API_KEY"],
		isolatedEnv: false,
		phaseLabel: "scout phase",
		phaseIndex: 1,
		phaseTotal: 3,
		// Longer than both compactInline widths (220 and 260) so the width
		// difference is observable in the rendered preview/output lines.
		promptPreview: "P".repeat(400),
		output: "O".repeat(400),
	};
}

function makeRun() {
	const now = Date.now();
	return {
		workflow: "demo-flow",
		scope: "project",
		file: "/nonexistent/demo-flow.js",
		runId: "run-1234567890abcd",
		runDir: "/tmp/nonexistent-run-dir",
		ok: true,
		state: "completed",
		startedAt: new Date(now - 60000).toISOString(),
		endedAt: new Date(now).toISOString(),
		elapsedMs: 60000,
		agentCount: 1,
		agentConcurrency: 2,
		parallelAgents: 1,
		peakParallelAgents: 1,
		logs: [],
	};
}

function makeMonitorModel(run, agent) {
	return {
		run,
		workflow: run.workflow,
		runId: run.runId,
		state: "completed",
		active: false,
		stale: false,
		elapsedMs: 60000,
		agentsStarted: 1,
		agentsDone: 1,
		parallelAgents: 1,
		peakParallelAgents: 1,
		agentConcurrency: 2,
		bashDone: 0,
		artifactCount: 1,
		agents: [agent],
		runDir: run.runDir,
		priority: "latest",
		canCancel: false,
		canRerun: false,
	};
}

/** Lines after the "Selected agent" header, as a label→line map for `label:` rows. */
function detailFields(lines) {
	const idx = lines.findIndex((l) => l.trim() === "Selected agent");
	if (idx < 0) return {};
	const fields = {};
	for (const raw of lines.slice(idx + 1)) {
		const m = raw.match(/^([a-z ]+): /);
		if (m) fields[m[1]] = raw;
	}
	return fields;
}

async function main() {
	const { url } = await buildExtension({
		name: "pi-dwf-selected-agent-detail",
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "workflow-dashboard.ts"),
		outName: "workflow-dashboard.mjs",
		stubs: { typebox: true, typeboxValue: true, ai: true, tui: true, sdk: (dir) => dir && "" },
	});
	const { WorkflowDashboard } = await loadModule(url);
	check("WorkflowDashboard class is exported", typeof WorkflowDashboard === "function");

	const build = (initialTab) => {
		const agent = makeAgent();
		const run = makeRun();
		return new WorkflowDashboard(
			[],
			[run],
			[],
			[],
			[makeMonitorModel(run, agent)],
			[{ run, agent }],
			theme,
			() => {},
			() => {},
			initialTab,
		);
	};

	const monitorFields = detailFields(build("monitor").render(WIDTH));
	const agentsFields = detailFields(build("agents").render(WIDTH));

	// Both tabs render a Selected agent detail at all.
	check(
		"Monitor renders agent detail line",
		typeof monitorFields.agent === "string",
		JSON.stringify(monitorFields.agent),
	);
	check(
		"Agents renders agent detail line",
		typeof agentsFields.agent === "string",
		JSON.stringify(agentsFields.agent),
	);

	// 1) Shared, byte-identical lines across both tabs (the whole point of the helper).
	for (const label of ["agent", "phase", "prompt", "tools", "skills", "extensions", "keys"]) {
		check(
			`"${label}:" line is byte-identical across Monitor and Agents`,
			monitorFields[label] !== undefined && monitorFields[label] === agentsFields[label],
			`monitor=${JSON.stringify(monitorFields[label])} agents=${JSON.stringify(agentsFields[label])}`,
		);
	}

	// 2) Intended difference A: Agents has a workflow/run/parallel header; Monitor doesn't.
	check(
		"Agents detail carries workflow/run/parallel header",
		!!agentsFields.workflow && !!agentsFields.run && !!agentsFields.parallel,
		`${agentsFields.workflow} | ${agentsFields.run} | ${agentsFields.parallel}`,
	);
	check(
		"Monitor detail omits the workflow/run/parallel header",
		!monitorFields.workflow && !monitorFields.run && !monitorFields.parallel,
		`${monitorFields.workflow} | ${monitorFields.run} | ${monitorFields.parallel}`,
	);

	// 3) Intended difference B: only Agents puts the schema suffix on the state line.
	check(
		"Agents state line includes the schema suffix",
		typeof agentsFields.state === "string" && agentsFields.state.includes("• schema ok"),
		JSON.stringify(agentsFields.state),
	);
	check(
		"Monitor state line omits the schema suffix",
		typeof monitorFields.state === "string" && !monitorFields.state.includes("schema"),
		JSON.stringify(monitorFields.state),
	);
	check(
		"state lines otherwise share their leading portion",
		typeof monitorFields.state === "string" &&
			typeof agentsFields.state === "string" &&
			agentsFields.state.startsWith(monitorFields.state),
		`monitor=${JSON.stringify(monitorFields.state)} agents=${JSON.stringify(agentsFields.state)}`,
	);

	// 4) Intended difference C: compactInline width 220 (Monitor) vs 260 (Agents).
	for (const label of ["prompt preview", "output"]) {
		const m = monitorFields[label];
		const a = agentsFields[label];
		check(
			`"${label}:" present in both tabs`,
			typeof m === "string" && typeof a === "string",
			`monitor=${typeof m} agents=${typeof a}`,
		);
		check(
			`"${label}:" Agents (width 260) renders longer than Monitor (width 220)`,
			typeof m === "string" && typeof a === "string" && a.length > m.length,
			`monitorLen=${m?.length} agentsLen=${a?.length}`,
		);
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
