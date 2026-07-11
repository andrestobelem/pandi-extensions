#!/usr/bin/env node
/**
 * Caracterización de señales de integridad en el reporte:
 * - la proyección JSON conserva una sola clave canónica por señal;
 * - el summary HTML emite un solo chip por señal, sin el alias `empty-output`.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createChecker } from "../../../../shared/test/harness.mjs";
import { buildDwfModule } from "../dwf-test-support.mjs";

const { check, counts } = createChecker();

function occurrences(text, token) {
	return text.split(token).length - 1;
}

function agentSummary(html, label) {
	const labelIndex = html.lastIndexOf(label);
	if (labelIndex < 0) return "";
	const start = html.lastIndexOf("<summary>", labelIndex);
	const end = html.indexOf("</summary>", labelIndex);
	return start < 0 || end < 0 ? "" : html.slice(start, end + "</summary>".length);
}

async function main() {
	const { url } = await buildDwfModule({
		name: "run-report-integrity-signal-projection",
		relPath: "observe/collector.ts",
		outName: "collector.mjs",
	});
	const mod = await import(url);
	const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-report-integrity-signals-"));

	try {
		await fs.mkdir(path.join(runDir, "agents"));
		await fs.writeFile(
			path.join(runDir, "status.json"),
			JSON.stringify({
				workflow: "integrity-signals",
				runId: "run-integrity-signals",
				runDir,
				state: "completed",
				background: true,
				active: false,
				startedAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:01.000Z",
				endedAt: "2026-01-01T00:00:01.000Z",
				agentCount: 1,
				logs: [],
			}),
		);
		await fs.writeFile(
			path.join(runDir, "events.jsonl"),
			`${JSON.stringify({
				type: "agent",
				id: 1,
				name: "integrity-agent",
				state: "completed",
				ok: true,
				output: "",
				outputChars: 123,
				outputEmpty: true,
				outputTruncated: true,
			})}\n`,
		);

		const report = await mod.collectRunReport(runDir, { generatedAt: "2026-01-02T00:00:00.000Z" });
		const agent = report.agents.find((candidate) => candidate.id === 1);
		const json = JSON.stringify(agent);
		// Estos checks ya pasaban con spreads duplicados: el objeto conserva la última asignación
		// antes de JSON.stringify. El RED observable de esa versión queda en los checks HTML de abajo.
		for (const key of ["outputChars", "outputEmpty", "outputTruncated"]) {
			check(`JSON projects ${key} exactly once`, occurrences(json, `"${key}":`) === 1, json);
		}

		const summary = agentSummary(mod.buildRunReportHtml(report), "#1 integrity-agent");
		check("agent HTML summary is present", summary.length > 0);
		check("HTML emits output:empty exactly once", occurrences(summary, "output:empty") === 1, summary);
		check("HTML emits output:truncated exactly once", occurrences(summary, "output:truncated") === 1, summary);
		check("HTML emits output chars exactly once", occurrences(summary, "output chars 123") === 1, summary);
		check("HTML omits the empty-output alias", !summary.includes("empty-output"), summary);
	} finally {
		await fs.rm(runDir, { recursive: true, force: true });
	}

	if (counts.failed > 0) {
		console.error(`\n${counts.failed} checks FAILED:`);
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
