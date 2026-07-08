#!/usr/bin/env node
/**
 * run-report-monitor-template — pinea la arquitectura de información monitor-first
 * para el HTML de /workflow report. El reporte debe abrir como el Monitor TUI:
 * state, progreso, paralelismo, artifacts, actividad reciente y una matriz compacta
 * de agentes antes de las secciones raw/debug más profundas.
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
				model: "anthropic/claude-sonnet-5",
				thinking: "low",
				schemaOk: true,
				phaseLabel: "Scout",
				promptAvailable: true,
				promptPreview: "inspect target files and summarize the risk before editing",
				prompt: { text: "inspect", truncated: false },
				output: { text: "ok result for monitor", truncated: false },
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
				model: "anthropic/claude-sonnet-5",
				thinking: "medium",
				schemaOk: false,
				phaseId: 2,
				phaseIndex: 1,
				phaseTotal: 3,
				phaseLabel: "Review",
				promptAvailable: true,
				promptPreview: "review failed branch and explain risk",
				output: { text: "boom output for monitor", truncated: false },
				artifactHref: "agents/0002-reviewer.md",
				tools: "read, bash",
				excludeTools: "write",
				skills: "karpathy-guidelines",
				includeSkills: true,
				extensions: "pi-codex-web-search",
				includeExtensions: true,
				keys: "OPENAI_API_KEY",
				missingKeys: "ANTHROPIC_API_KEY",
				isolatedEnv: true,
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
const monitorStart = html.indexOf("Workflow monitor");
const monitorEnd = html.indexOf("<h2>Agents (2)</h2>");
check("monitor slice is bounded by the deeper Agents section", monitorStart >= 0 && monitorEnd > monitorStart, html);
const monitorSlice = html.slice(monitorStart, monitorEnd);
const monitorText = monitorSlice.replace(/<[^>]+>/g, "");
const collapsedMonitorText = monitorText.replace(/\s+/g, " ");
check(
	"monitor agent header mirrors the TUI line",
	collapsedMonitorText.includes("Agents (2)") &&
		collapsedMonitorText.includes("parallel 0/3") &&
		collapsedMonitorText.includes("peak 2"),
	monitorSlice,
);
check(
	"monitor row reads like a TUI agent line",
	collapsedMonitorText.includes("✗ failed") &&
		collapsedMonitorText.includes("#2") &&
		collapsedMonitorText.includes("P2 1/3") &&
		collapsedMonitorText.includes("reviewer") &&
		collapsedMonitorText.includes("elapsed:3s") &&
		collapsedMonitorText.includes("code:1"),
	monitorSlice,
);
check("monitor row surfaces prompt chip early", monitorSlice.includes("prompt✓"), monitorSlice);
check("monitor row surfaces compact schema ok chip early", monitorSlice.includes("schema:ok"), monitorSlice);
check("monitor row surfaces compact schema bad chip early", monitorSlice.includes("schema:bad"), monitorSlice);
check("monitor row surfaces short model chip early", monitorSlice.includes("model:claude-sonnet-5"), monitorSlice);
check("monitor row surfaces effort chip early", monitorSlice.includes("effort:low"), monitorSlice);
check("monitor row counts tools early", monitorSlice.includes("tools:2"), monitorSlice);
check("monitor row counts skills early", monitorSlice.includes("skills:1"), monitorSlice);
check("monitor row counts extensions early", monitorSlice.includes("ext:1"), monitorSlice);
check("monitor row counts key access early", monitorSlice.includes("keys:1"), monitorSlice);
check("monitor row counts missing keys early", monitorSlice.includes("missing:1"), monitorSlice);
check(
	"monitor selected agent has a structured detail block",
	collapsedMonitorText.includes("agent: #2 P2 1/3 reviewer"),
	monitorSlice,
);
check(
	"monitor selected agent formats state elapsed/code like Monitor",
	collapsedMonitorText.includes("state: failed • 3s • code 1"),
	monitorSlice,
);
check(
	"monitor selected agent surfaces structured phase label early",
	collapsedMonitorText.includes("phase: P2 1/3 • Review"),
	monitorSlice,
);
check("monitor selected agent surfaces prompt artifact early", monitorText.includes("prompt: available"), monitorSlice);
check("monitor selected agent surfaces config section early", monitorText.includes("config"), monitorSlice);
check(
	"monitor selected agent surfaces full model and effort early",
	monitorText.includes("model: anthropic/claude-sonnet-5") && monitorText.includes("effort: medium"),
	monitorSlice,
);
check("monitor selected agent surfaces excluded tools early", monitorText.includes("exclude: write"), monitorSlice);
check(
	"monitor selected agent surfaces skills discovery early",
	monitorText.includes("skills: karpathy-guidelines + discovery"),
	monitorSlice,
);
check(
	"monitor selected agent surfaces extension discovery early",
	monitorText.includes("extensions: pi-codex-web-search + discovery"),
	monitorSlice,
);
check("monitor selected agent surfaces key access early", monitorText.includes("keys: OPENAI_API_KEY"), monitorSlice);
check(
	"monitor selected agent surfaces missing keys early",
	monitorText.includes("missing: ANTHROPIC_API_KEY"),
	monitorSlice,
);
check("monitor selected agent surfaces i/o section early", monitorText.includes("i/o"), monitorSlice);
check(
	"monitor selected agent surfaces prompt preview early",
	monitorText.includes("prompt preview: review failed branch"),
	monitorSlice,
);
check(
	"monitor selected agent surfaces output preview early",
	monitorText.includes("output: boom output for monitor"),
	monitorSlice,
);
// El contrato ya no es "cero <script>": desde el diagrama Mermaid del run (pineado en
// run-report-security.test.mjs) hay exactamente dos <script> fijos (loader CDN + init
// securityLevel:"sandbox"). Acá solo confirmamos que no aparece NINGÚN OTRO <script>.
const templateScriptTags = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [];
check(
	"run report only contains the two pinned mermaid <script> tags, nothing else",
	templateScriptTags.length <= 2 &&
		templateScriptTags.every(
			(tag) => tag.includes("cdn.jsdelivr.net/npm/mermaid@") || tag.includes('securityLevel:"sandbox"'),
		),
	templateScriptTags.join("\n"),
);

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
	interruptedHtml.includes('class="callout error monitor-selected"') &&
		/interrupted-reviewer[\s\S]*state:<\/span> interrupted/.test(interruptedHtml),
	interruptedHtml,
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
