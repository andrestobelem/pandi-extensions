#!/usr/bin/env node
/**
 * run-report-json-output — si un output del reporte es JSON, se muestra como JSON
 * formateado en <pre>, no como Markdown/prosa.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createChecker, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildBuilder() {
	const { url } = await sharedBuildExtension({
		name: "pi-run-report-json-output",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "run-report-html.ts"),
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
		output: { text: '{"ok":true,"items":[{"id":1,"name":"bamboo"}]}', truncated: false },
		outputFormat: "pre",
		logs: [],
		phases: [],
		agents: [
			{
				id: 1,
				name: "json-agent",
				state: "completed",
				ok: true,
				promptAvailable: false,
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

check(
	"final JSON output is pretty printed",
	html.includes(`{
  &quot;ok&quot;: true,
  &quot;items&quot;: [`) ||
		html.includes(`{
  "ok": true,
  "items": [`),
	html,
);
check(
	"agent JSON output is pretty printed",
	html.includes(`{
  &quot;answer&quot;: {
    &quot;score&quot;: 1`) ||
		html.includes(`{
  "answer": {
    "score": 1`),
	html,
);
check("JSON output uses a json code block class", /<pre class="json-output">/.test(html), html);

if (counts.failed > 0) {
	console.error("\nFailures:");
	for (const failure of counts.failures) console.error(`- ${failure}`);
	process.exit(1);
}
console.log(`\n${counts.passed} checks passed`);
