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
				phaseLabel: "Scout",
				prompt: { text: "inspect", truncated: false },
				output: { text: "ok", truncated: false },
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
check("run report remains script-free", !/<script/i.test(html));

if (counts.failed > 0) {
	console.error(`\n${counts.failed} checks FAILED:`);
	for (const failure of counts.failures) console.error(`- ${failure}`);
	process.exit(1);
}
console.log(`\n${counts.passed} checks passed`);
