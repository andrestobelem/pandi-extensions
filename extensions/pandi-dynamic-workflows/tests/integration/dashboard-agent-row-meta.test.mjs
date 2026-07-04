#!/usr/bin/env node
/**
 * Behavioral contract test for the shared per-row agent meta suffix.
 *
 * Each agent row in the Monitor tab (renderMonitorAgents) and the Agents tab
 * (renderAgents) ends with the same chip suffix:
 *
 *   prompt<✓|?> schema:… tools:… skills:… ext:… keys:… [missing:…]
 *
 * That suffix used to be built with near-identical muted/success/warning/error
 * expressions in BOTH methods; it is now produced by one private helper
 * (renderAgentRowMeta). The two rows still differ ONLY in the segment between the
 * agent name and that suffix:
 *
 *   - Monitor inserts a `code:` chip after `elapsed:` (no workflow/run segment).
 *   - Agents inserts a `— <workflow> <runId>` segment before `elapsed:` (no code chip).
 *
 * This test pins the OBSERVABLE contract: for an equivalent agent, the meta suffix
 * (prompt…keys) is byte-identical across both tabs, while the two intended
 * differences are preserved. It guards against the two copies silently diverging
 * (e.g. a future edit touching only one tab's chip formatting).
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

const theme = { fg: (_c, v) => v, bg: (_c, v) => v, bold: (v) => v };
const WIDTH = 10000; // wide enough that truncateToWidth never trims the row

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
		extensions: ["pandi-loop"],
		includeExtensions: false,
		keys: ["OPENAI_API_KEY"],
		missingKeys: ["ANTHROPIC_API_KEY"],
		isolatedEnv: false,
		phaseLabel: "scout phase",
		phaseIndex: 1,
		phaseTotal: 3,
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

/** The agent ROW line is the unique line carrying the prompt chip (`prompt✓`). */
function agentRow(lines) {
	return lines.find((l) => l.includes("prompt✓"));
}

/** The shared meta suffix = from the prompt chip to end-of-line. */
function rowMeta(row) {
	return typeof row === "string" ? row.slice(row.indexOf("prompt✓")) : undefined;
}

/** The tab-specific prefix = everything BEFORE the shared meta suffix. */
function rowPrefix(row) {
	return typeof row === "string" ? row.slice(0, row.indexOf("prompt✓")) : undefined;
}

async function main() {
	const { url } = await buildExtension({
		name: "pi-dwf-agent-row-meta",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "workflow-dashboard.ts"),
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

	const monitorRow = agentRow(build("monitor").render(WIDTH));
	const agentsRow = agentRow(build("agents").render(WIDTH));

	// Both tabs render an agent row with the prompt chip at all.
	check("Monitor renders an agent row", typeof monitorRow === "string", JSON.stringify(monitorRow));
	check("Agents renders an agent row", typeof agentsRow === "string", JSON.stringify(agentsRow));

	const monitorMeta = rowMeta(monitorRow);
	const agentsMeta = rowMeta(agentsRow);

	// 1) The shared meta suffix (prompt…keys) is byte-identical across both tabs.
	check(
		"per-row meta suffix (prompt…keys) is byte-identical across Monitor and Agents",
		monitorMeta !== undefined && monitorMeta === agentsMeta,
		`monitor=${JSON.stringify(monitorMeta)} agents=${JSON.stringify(agentsMeta)}`,
	);
	// Sanity: the suffix actually carries every chip the helper builds.
	check(
		"meta suffix carries every chip",
		typeof monitorMeta === "string" &&
			["prompt✓", "schema:ok", "tools:2", "skills:1", "ext:1", "keys:1", "missing:1"].every((chip) =>
				monitorMeta.includes(chip),
			),
		JSON.stringify(monitorMeta),
	);

	const monitorPrefix = rowPrefix(monitorRow);
	const agentsPrefix = rowPrefix(agentsRow);

	// 2) Intended difference A: only Monitor carries the `code:` chip.
	check(
		"Monitor row prefix includes the code chip",
		typeof monitorPrefix === "string" && monitorPrefix.includes("code:0"),
		JSON.stringify(monitorPrefix),
	);
	check(
		"Agents row prefix omits the code chip",
		typeof agentsPrefix === "string" && !agentsPrefix.includes("code:"),
		JSON.stringify(agentsPrefix),
	);

	// 3) Intended difference B: only Agents carries the `— <workflow> <runId>` segment.
	check(
		"Agents row prefix includes the — workflow runId segment",
		typeof agentsPrefix === "string" && agentsPrefix.includes(`— demo-flow ${"run-1234567890abcd".slice(-12)}`),
		JSON.stringify(agentsPrefix),
	);
	check(
		"Monitor row prefix omits the — workflow segment",
		typeof monitorPrefix === "string" && !monitorPrefix.includes("— demo-flow"),
		JSON.stringify(monitorPrefix),
	);

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
