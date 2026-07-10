#!/usr/bin/env node
/**
 * run-report-json-output — si un output del reporte es JSON, se muestra primero
 * como contenido estructurado legible (Markdown sanitizado), con raw JSON colapsable
 * como fallback de depuración.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createChecker, buildExtension as sharedBuildExtension } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildBuilder() {
	const { url } = await sharedBuildExtension({
		name: "pi-run-report-json-output",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "observe/html.ts"),
		outName: "run-report-html.mjs",
	});
	return await import(url);
}

function model() {
	return {
		workflow: "json-output-demo",
		runId: "2026-01-01T00-00-00-000Z-json-output-demo",
		state: "completed",
		liveness: "verified",
		generatedAt: "2026-01-02T03:04:05.000Z",
		output: {
			text: JSON.stringify({
				improvedTask: "Revisar el bambudal con calma",
				successCriteria: ["Criterio uno", "Criterio dos"],
				assumptions: [{ assumption: "Hay bambú", confidence: "high", invalidatedBy: "No hay bambú" }],
				nonGoals: ["No publicar"],
				constraints: ["Sin scripts extra"],
				routingHints: { shape: "single-agent", pattern: "n/a", maxAgents: 1, concurrency: "none" },
				verificationPlan: "Abrir el reporte y correr tests.",
				blockers: [],
			}),
			truncated: false,
		},
		outputFormat: "pre",
		logs: [],
		phases: [],
		agents: [
			{
				id: 1,
				name: "json-agent",
				state: "completed",
				ok: true,
				promptAvailable: true,
				prompt: {
					text: "## Prompt title\n\n- item\n\n```ts\nconst ok = true;\n```\n\n<script>alert(1)</script>",
					truncated: false,
				},
				output: { text: '{"answer":{"score":1},"tags":["json","report"]}', truncated: false },
			},
		],
		artifacts: [],
		missingFiles: [],
		clampNotes: [],
	};
}

const mod = await buildBuilder();
check("buildRunReportHtml is exported", typeof mod.buildRunReportHtml === "function");
const html = mod.buildRunReportHtml(model());

check("structured output wrapper is present", /class="structured-output"/.test(html), html);
check("contract-ish key renders as a readable heading", html.includes("Improved task"), html);
check("array of strings renders as bullets", /<li>Criterio uno<\/li>/.test(html), html);
check("array of objects renders as a table", html.includes("<table>") && html.includes("assumption"), html);
check("raw JSON fallback remains available", /<summary>Raw JSON<\/summary>/.test(html), html);
check(
	"final output is not primarily only a JSON pre",
	!/<h2>Final output<\/h2>[\s\S]{0,200}<pre class="json-output">/.test(html),
	html,
);

check("agent JSON output also renders structured", html.includes("Answer") && html.includes("score"), html);
check(
	"prompt renders through markdown body",
	/Prompt[\s\S]*class="md-body"[\s\S]*<h2>Prompt title<\/h2>/.test(html),
	html,
);
check("prompt code fence is rendered", html.includes("const ok = true;"), html);
check("prompt raw script is escaped/sanitized", !html.includes("<script>alert(1)</script>"), html);

const timelineHtml = mod.buildRunReportHtml({
	workflow: "timeline-demo",
	runId: "run-timeline",
	state: "completed",
	liveness: "verified",
	generatedAt: "2026-01-01T00:00:03.000Z",
	logs: [
		{ time: "2026-01-01T00:00:00.000Z", message: "workflow start: timeline-demo" },
		{ time: "2026-01-01T00:00:01.000Z", message: "phase: review" },
		{
			time: "2026-01-01T00:00:02.000Z",
			message: "agent 1 end: review",
			details: '{"ok":true,"elapsedMs":1200}',
		},
	],
	phases: [],
	agents: [],
	artifacts: [],
	missingFiles: [],
	clampNotes: [],
});
const timelineBody = timelineHtml.slice(timelineHtml.indexOf('class="timeline-list"'));
check("timeline list wrapper is present", timelineHtml.includes('class="timeline-list"'), timelineHtml);
check("timeline items are present", (timelineHtml.match(/class="timeline-item/g) ?? []).length === 3, timelineHtml);
check(
	"timeline keeps chronological order",
	timelineBody.indexOf("workflow start") < timelineBody.indexOf("phase: review") &&
		timelineBody.indexOf("phase: review") < timelineBody.indexOf("agent 1 end"),
	timelineHtml,
);
check("timeline timestamp is visible", timelineHtml.includes("2026-01-01T00:00:01.000Z"), timelineHtml);
check(
	"timeline details are pretty printed when JSON",
	timelineHtml.includes("&quot;elapsedMs&quot;: 1200") || timelineHtml.includes('"elapsedMs": 1200'),
	timelineHtml,
);
check(
	"legacy log table is not the primary timeline body",
	!timelineHtml.includes("<th>Message</th></tr></thead><tbody><tr>"),
	timelineHtml,
);

if (counts.failed > 0) {
	console.error("\nFailures:");
	for (const failure of counts.failures) console.error(`- ${failure}`);
	process.exit(1);
}
console.log(`\n${counts.passed} checks passed`);
