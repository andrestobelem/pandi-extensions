/**
 * run-report-narrative — pinea la "apertura de 30 segundos" didáctica para reportes
 * de runs de workflow. El reporte estático debe orientar a la persona lectora antes de cualquier
 * sección de detalle: qué pasó, dónde mirar después y por qué importan los datos raw de abajo.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createChecker, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildBuilder() {
	const { url } = await sharedBuildExtension({
		name: "pi-run-report-narrative",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "run-report-html.ts"),
		outName: "run-report-html.mjs",
	});
	return await import(url);
}

function baseModel(overrides = {}) {
	return {
		workflow: "narrative-demo",
		runId: "2026-01-01T00-00-00-000Z-narrative-demo-aaaa1111",
		state: "completed",
		liveness: "verified",
		generatedAt: "2026-01-01T00:02:00.000Z",
		startedAt: "2026-01-01T00:00:00.000Z",
		endedAt: "2026-01-01T00:02:00.000Z",
		elapsedMs: 120000,
		logs: [],
		phases: [],
		agents: [
			{ id: 1, name: "scout", state: "completed", ok: true, phaseLabel: "Scout" },
			{ id: 2, name: "review-a", state: "completed", ok: true, phaseLabel: "Review" },
			{ id: 3, name: "review-b", state: "failed", ok: false, code: 1, phaseLabel: "Review" },
			{ id: 4, name: "synthesis", state: "completed", ok: true, phaseLabel: "Synthesize" },
		],
		artifacts: [],
		missingFiles: [],
		clampNotes: [],
		...overrides,
	};
}

function headerBeforeFirstH2(html) {
	const firstH2 = html.indexOf("<h2>");
	return firstH2 >= 0 ? html.slice(0, firstH2) : html;
}

async function main() {
	const mod = await buildBuilder();
	check("buildRunReportHtml is exported", typeof mod.buildRunReportHtml === "function");

	const failedHtml = mod.buildRunReportHtml(baseModel({ state: "failed", error: "one reviewer timed out" }));
	const failedHeader = headerBeforeFirstH2(failedHtml);
	check("opening summary renders before first detail section", /class="opening"/.test(failedHeader));
	check("failed opening names failed agents", /1 de 4 agentes fall[oó]/i.test(failedHeader), failedHeader);
	check("failed opening points to open cards", /tarjetas fallidas/i.test(failedHeader), failedHeader);

	const completedHtml = mod.buildRunReportHtml(
		baseModel({ agents: baseModel().agents.map((a) => ({ ...a, state: "completed", ok: true })) }),
	);
	const completedHeader = headerBeforeFirstH2(completedHtml);
	check("completed opening is calm and before sections", /class="opening"/.test(completedHeader));
	check("completed opening summarizes all agents ok", /4 agentes completaron/i.test(completedHeader), completedHeader);

	const runningHtml = mod.buildRunReportHtml(baseModel({ state: "running", endedAt: undefined }));
	const runningHeader = headerBeforeFirstH2(runningHtml);
	check("running opening says snapshot", /instant[aá]nea|snapshot/i.test(runningHeader), runningHeader);

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
