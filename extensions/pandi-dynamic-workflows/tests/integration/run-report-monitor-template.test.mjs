#!/usr/bin/env node
/**
 * run-report-monitor-template — pins the monitor-first information architecture
 * for /workflow report HTML. The report should open like the TUI Monitor:
 * state, progress, parallelism, artifacts, latest activity, and a compact agent
 * matrix before the deeper raw/debug sections.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createChecker, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildBuilder() {
	const { url } = await sharedBuildExtension({
		name: "pi-run-report-monitor-template",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "run-report-html.ts"),
		outName: "run-report-html.mjs",
	});
	return await import(url);
}

function model() {
	return {
		workflow: "monitor-demo",
		runId: "2026-01-01T00-00-00-000Z-monitor-demo",
		state: "completed",
		liveness: "verified",
		generatedAt: "2026-01-02T03:04:05.000Z",
		elapsedMs: 4200,
		agentConcurrency: 3,
		peakParallelAgents: 2,
		output: { text: "final synthesis", truncated: false },
		logs: [
			{ time: "2026-01-01T00:00:01.000Z", message: "phase: Scout" },
			{ time: "2026-01-01T00:00:04.000Z", message: "agent 2 end: reviewer" },
		],
		phases: [{ label: "Scout", time: "2026-01-01T00:00:01.000Z", source: "log" }],
		agents: [
			{
				id: 1,
				name: "scout",
				state: "completed",
				ok: true,
				elapsedMs: 1200,
				model: "haiku",
				thinking: "low",
				schemaOk: true,
				phaseLabel: "Scout",
				promptAvailable: true,
				prompt: { text: "inspect", truncated: false },
				output: { text: "ok", truncated: false },
				artifactHref: "agents/0001-scout.md",
				tools: "read, bash",
				excludeTools: "write",
				skills: "karpathy-guidelines",
				includeSkills: true,
				extensions: "pi-codex-web-search",
				includeExtensions: true,
				keys: "OPENAI_API_KEY",
				missingKeys: "ANTHROPIC_API_KEY",
				isolatedEnv: true,
			},
			{
				id: 2,
				name: "reviewer",
				state: "failed",
				ok: false,
				code: 1,
				elapsedMs: 3000,
				model: "sonnet",
				thinking: "medium",
				phaseLabel: "Review",
				stderrTail: { text: "boom" },
			},
		],
		metricsTotals: { measuredAgents: 2, okAgents: 1, failedAgents: 1, toolCalls: 5 },
		artifacts: [{ path: "summary.md", bytes: 42 }],
		missingFiles: [],
		clampNotes: [],
	};
}

const mod = await buildBuilder();
check("buildRunReportHtml is exported", typeof mod.buildRunReportHtml === "function");
const html = mod.buildRunReportHtml(model());

check("report starts with a Workflow monitor section", html.includes("Workflow monitor"));
check(
	"monitor appears before final output",
	html.indexOf("Workflow monitor") >= 0 && html.indexOf("Workflow monitor") < html.indexOf("Final output"),
);
check("monitor labels progress", html.includes("Progress"));
check("monitor shows parallelism", html.includes("parallel") && html.includes("peak"));
check("monitor shows artifacts", html.includes("artifacts") && html.includes("summary.md"));
check("monitor shows latest activity", html.includes("Latest activity") && html.includes("agent 2 end: reviewer"));
check("monitor includes a compact agent matrix", html.includes("Agent monitor") && html.includes("reviewer"));
check("monitor makes failed agents visible early", html.indexOf("reviewer") < html.indexOf("Agents (2)"));
const monitorSlice = html.slice(html.indexOf("Workflow monitor"), html.indexOf("Agents (2)"));
check("monitor surfaces prompt availability early", monitorSlice.includes("prompt✓"), monitorSlice);
check("monitor surfaces schema state early", monitorSlice.includes("schema ok"), monitorSlice);
check("monitor surfaces excluded tools early", monitorSlice.includes("exclude: write"), monitorSlice);
check(
	"monitor surfaces skills discovery early",
	monitorSlice.includes("skills: karpathy-guidelines + discovery"),
	monitorSlice,
);
check(
	"monitor surfaces extension discovery early",
	monitorSlice.includes("extensions: pi-codex-web-search + discovery"),
	monitorSlice,
);
check("monitor surfaces key access early", monitorSlice.includes("keys: OPENAI_API_KEY"), monitorSlice);
check("monitor surfaces missing keys early", monitorSlice.includes("missing: ANTHROPIC_API_KEY"), monitorSlice);
check("run report remains script-free", !/<script/i.test(html));

const interruptedHtml = mod.buildRunReportHtml({
	...model(),
	agents: [
		{
			id: 7,
			name: "interrupted-reviewer",
			state: "interrupted",
			phaseLabel: "Review",
			model: "sonnet",
			thinking: "medium",
			elapsedMs: 9000,
			stderrTail: { text: "cancelled by terminal state" },
		},
	],
	metricsTotals: { measuredAgents: 1, okAgents: 0, failedAgents: 1 },
});
check("interrupted agents count as failed in the opening", interruptedHtml.includes("1 de 1 agente falló"));
check(
	"interrupted agents drive the monitor failure metric",
	interruptedHtml.includes('<div class="metric-label">failed</div><div class="metric-value">1</div>'),
);
check("interrupted progress meter is failure-toned", interruptedHtml.includes('class="meter fail"'));
check(
	"interrupted agents are highlighted as failed cards",
	/<details class="fail-card" open>[\s\S]*interrupted-reviewer/.test(interruptedHtml),
);
check(
	"interrupted selected agent uses an error callout",
	/<div class="callout error"><b>Selected agent:<\/b>[\s\S]*interrupted-reviewer[\s\S]*interrupted/.test(
		interruptedHtml,
	),
);

const unknownHtml = mod.buildRunReportHtml({
	...model(),
	agents: [{ id: 8, name: "unknown-worker", state: "unknown", phaseLabel: "Review" }],
	metricsTotals: { measuredAgents: 1, okAgents: 0, failedAgents: 0 },
});
check(
	"unknown terminal agents count as progress done",
	unknownHtml.includes('<div class="metric-label">Progress</div><div class="metric-value">1/1</div>'),
	unknownHtml,
);

const partialPhaseHtml = mod.buildRunReportHtml({
	...model(),
	state: "running",
	agents: [
		{ id: 1, name: "worker-1", state: "completed", ok: true, phaseId: 1, phaseIndex: 1, phaseTotal: 4 },
		{ id: 2, name: "worker-2", state: "completed", ok: true, phaseId: 1, phaseIndex: 2, phaseTotal: 4 },
		{ id: 3, name: "worker-3", state: "completed", ok: true, phaseId: 1, phaseIndex: 3, phaseTotal: 4 },
	],
	metricsTotals: { measuredAgents: 3, okAgents: 3, failedAgents: 0 },
});
check(
	"phaseTotal drives monitor progress denominator",
	partialPhaseHtml.includes('<div class="metric-label">Progress</div><div class="metric-value">3/4</div>'),
	partialPhaseHtml,
);

if (counts.failed > 0) {
	console.error(`\n${counts.failed} checks FAILED:`);
	for (const failure of counts.failures) console.error(`- ${failure}`);
	process.exit(1);
}
console.log(`\n${counts.passed} checks passed`);
