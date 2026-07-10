#!/usr/bin/env node
/**
 * Tests de contrato para la capa de datos del dashboard (dashboard-collectors.ts): el lado de lectura
 * que renderiza Monitor. Fija dos helpers exportados y críticos para comportamiento que no tenían cobertura
 * directa mientras workflow-dashboard.ts está en refactor activo:
 *
 *   - collectWorkflowActivity(runs, maxRuns, maxEntries): el activity feed. Pliega los logs inline
 *     de cada run (sin lectura de disco cuando `logs` no está vacío) en entries, conserva solo
 *     los últimos 20 por run, ordena newest-first por `time`, capa a maxEntries, y lleva
 *     `details` SOLO cuando está definido (así el spread nunca inyecta `details: undefined`).
 *   - canRerunRun(run): gatea la acción rerun; true solo cuando el run NO está running Y
 *     su `file` de workflow todavía existe en disco.
 *
 * Determinista + offline: los records de activity llevan `logs` inline, así collectWorkflowActivity
 * nunca toca el run dir; canRerunRun se ejercita contra un archivo temp real. Bundleamos
 * dashboard-collectors.ts (que arrastra transitivamente index.ts) con los stubs estándar.
 *
 * Ejecutalo:
 *   node extensions/pandi-dynamic-workflows/tests/integration/dashboard-collectors-contract.test.mjs
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, sdkStub } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const { check, counts } = createChecker();

async function loadModule() {
	const { url } = await buildExtension({
		name: "pi-dwf-dashboard-collectors",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "tui/collectors.ts"),
		outName: "dashboard-collectors.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
	});
	return await import(url);
}

// Record de run plano SIN key "ok", así getRunState devuelve run.state verbatim y
// getRunLogs devuelve los logs inline (collectWorkflowActivity entonces nunca lee el run dir).
const run = (runId, workflow, state, logs) => ({ runId, workflow, state, runDir: "/does/not/exist", logs });
const log = (time, message, details) => (details === undefined ? { time, message } : { time, message, details });

async function main() {
	const { collectWorkflowActivity, canRerunRun } = await loadModule();

	// 1) Orden newest-first entre runs, con campos run-level preservados.
	const ordered = await collectWorkflowActivity([
		run("r1", "alpha", "running", [log("2026-01-01T00:00:01Z", "a-old"), log("2026-01-01T00:00:03Z", "a-new")]),
		run("r2", "beta", "completed", [log("2026-01-01T00:00:02Z", "b-mid")]),
	]);
	check(
		"activity: sorted newest-first by time across runs",
		ordered.map((e) => e.message).join(",") === "a-new,b-mid,a-old",
		ordered.map((e) => e.message).join(","),
	);
	check(
		"activity: carries runId/workflow/state from the run (not the log)",
		ordered[0].runId === "r1" && ordered[0].workflow === "alpha" && ordered[0].state === "running",
	);

	// 2) details se incluye SOLO cuando está definido (el spread no debe inyectar details:undefined).
	const withDetails = await collectWorkflowActivity([
		run("r1", "alpha", "running", [
			log("2026-01-01T00:00:02Z", "has-details", { k: 1 }),
			log("2026-01-01T00:00:01Z", "no-details"),
		]),
	]);
	const hasOne = withDetails.find((e) => e.message === "has-details");
	const hasNone = withDetails.find((e) => e.message === "no-details");
	check("activity: keeps details when defined", "details" in hasOne && hasOne.details.k === 1);
	check("activity: omits the details key entirely when undefined", !("details" in hasNone));

	// 3) Cap por run = últimas 20 entries de log (el run de 25 entries dropea sus 5 más viejas).
	const many = Array.from({ length: 25 }, (_, i) =>
		// índice zero-padded en time Y message para que el orden lexical de time coincida con el numérico.
		log(`2026-01-02T00:00:${String(i).padStart(2, "0")}Z`, `m${String(i).padStart(2, "0")}`),
	);
	const capped = await collectWorkflowActivity([run("r1", "alpha", "running", many)]);
	check("activity: keeps at most the last 20 entries per run", capped.length === 20, `len=${capped.length}`);
	check(
		"activity: dropped the 5 OLDEST entries (m00..m04 absent, m24 present)",
		!capped.some((e) => e.message === "m04") && capped.some((e) => e.message === "m24"),
	);

	// 4) maxEntries capa el resultado global a las N más nuevas después de ordenar.
	const limited = await collectWorkflowActivity(
		[
			run("r1", "alpha", "running", [
				log("2026-01-03T00:00:01Z", "x1"),
				log("2026-01-03T00:00:02Z", "x2"),
				log("2026-01-03T00:00:03Z", "x3"),
			]),
		],
		12,
		2,
	);
	check(
		"activity: maxEntries caps to the N newest",
		limited.length === 2 && limited.map((e) => e.message).join(",") === "x3,x2",
		limited.map((e) => e.message).join(","),
	);

	// 5) maxRuns capa cuántos runs se escanean (runs posteriores ignorados por completo).
	const scanned = await collectWorkflowActivity(
		[
			run("r1", "alpha", "running", [log("2026-01-04T00:00:01Z", "kept")]),
			run("r2", "beta", "running", [log("2026-01-04T00:00:09Z", "ignored")]),
		],
		1,
	);
	check(
		"activity: maxRuns limits scanned runs (second run skipped even if newer)",
		scanned.length === 1 && scanned[0].message === "kept",
		JSON.stringify(scanned.map((e) => e.message)),
	);

	// 6) Input vacío → feed vacío.
	check("activity: empty runs → []", (await collectWorkflowActivity([])).length === 0);

	// --- canRerunRun ---------------------------------------------------------
	const dir = mkdtempSync(path.join(os.tmpdir(), "dwf-rerun-"));
	const existing = path.join(dir, "wf.workflow.js");
	writeFileSync(existing, "export const meta = {};\n");
	const missing = path.join(dir, "gone.workflow.js");
	try {
		check("canRerun: running run is never rerunnable", canRerunRun({ state: "running", file: existing }) === false);
		check("canRerun: completed + existing file → true", canRerunRun({ state: "completed", file: existing }) === true);
		check("canRerun: completed + missing file → false", canRerunRun({ state: "completed", file: missing }) === false);
		check("canRerun: completed + no file recorded → false", canRerunRun({ state: "completed" }) === false);
		check(
			"canRerun: failed run with file → true (only running blocks)",
			canRerunRun({ state: "failed", file: existing }) === true,
		);
		check("canRerun: stale run with file → true", canRerunRun({ state: "stale", file: existing }) === true);
		// Guardá la premisa propia del test: el archivo temp realmente existe, el otro realmente no.
		check(
			"canRerun: fixture sanity (existing present, missing absent)",
			existsSync(existing) && !existsSync(missing),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.error(counts.failures.join("\n"));
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err?.stack || err);
	process.exit(1);
});
