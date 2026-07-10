#!/usr/bin/env node
/**
 * Test de contrato para la política de SELECCIÓN de run-cleanup (run-state.ts, selectRunsForCleanup).
 *
 * `/workflow cleanup runs` debe ser seguro por construcción: borra solo directorios de run
 * TERMINALES y nunca un run que sigue corriendo o trackeado como activo en memoria, y siempre
 * retiene los `keep` runs más recientes para que un cleanup masivo no borre la historia más fresca.
 * El wrapper IO (lifecycle/cleanup.ts, cleanupWorkflowRuns) hace el `fs.rm` real;
 * esto pinea la decisión pura para que un refactor futuro del wrapper no empiece silenciosamente
 * a seleccionar un run running/active ni a soltar la ventana de retención.
 *
 * Puro + offline: bundlea run-state.ts (dep type-only en index.ts) con stubs estándar y
 * llama el selector exportado en memoria. No toca run dirs.
 *
 * Corrélo:
 *   node extensions/pandi-dynamic-workflows/tests/integration/cleanup-runs-select.test.mjs
 */
import * as path from "node:path";
import { buildExtension, createChecker, REPO_ROOT } from "../../../../shared/test/harness.mjs";

const { check, counts } = createChecker();

async function loadModule() {
	const { url } = await buildExtension({
		name: "pi-dwf-cleanup-runs-select",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "run-state.ts"),
		outName: "run-state.mjs",
		stubs: { typebox: true, typeboxValue: true, ai: true, tui: true, sdk: (dir) => dir && "" },
	});
	return await import(url);
}

// Un run record SIN key "ok" para que getRunState devuelva run.state verbatim.
const run = (runId, state, startedAt) => ({
	runId,
	workflow: "drafts/x",
	state,
	startedAt,
	runDir: `/runs/${runId}`,
});
const ids = (runs) => runs.map((r) => r.runId);

async function main() {
	const { selectRunsForCleanup } = await loadModule();
	check("exports selectRunsForCleanup", typeof selectRunsForCleanup === "function", typeof selectRunsForCleanup);

	const empty = new Set();

	// 1) running NUNCA se selecciona, incluso más allá de la ventana keep.
	{
		const runs = [
			run("r5", "running", "2026-06-01T00:00:05Z"),
			run("r4", "completed", "2026-06-01T00:00:04Z"),
			run("r3", "failed", "2026-06-01T00:00:03Z"),
			run("r2", "cancelled", "2026-06-01T00:00:02Z"),
			run("r1", "stale", "2026-06-01T00:00:01Z"),
		];
		const selected = selectRunsForCleanup(runs, { keep: 0, activeIds: empty });
		check("running never selected", !ids(selected).includes("r5"), JSON.stringify(ids(selected)));
		check(
			"all four terminal states selectable with keep=0",
			["r1", "r2", "r3", "r4"].every((id) => ids(selected).includes(id)),
			JSON.stringify(ids(selected)),
		);
	}

	// 2) activeIds nunca se seleccionan aunque su state parezca terminal.
	{
		const runs = [run("a1", "failed", "2026-06-01T00:00:02Z"), run("a2", "completed", "2026-06-01T00:00:01Z")];
		const selected = selectRunsForCleanup(runs, { keep: 0, activeIds: new Set(["a1"]) });
		check("active id excluded", !ids(selected).includes("a1"), JSON.stringify(ids(selected)));
		check("non-active terminal included", ids(selected).includes("a2"), JSON.stringify(ids(selected)));
	}

	// 3) keep=N retiene los N más recientes (por startedAt desc); se seleccionan runs terminales más viejos.
	{
		const runs = [
			run("old1", "completed", "2026-06-01T00:00:01Z"),
			run("old2", "completed", "2026-06-01T00:00:02Z"),
			run("new1", "completed", "2026-06-01T00:00:03Z"),
			run("new2", "completed", "2026-06-01T00:00:04Z"),
		];
		const selected = selectRunsForCleanup(runs, { keep: 2, activeIds: empty });
		check(
			"keep=2 selects the 2 oldest",
			ids(selected).sort().join(",") === "old1,old2",
			JSON.stringify(ids(selected)),
		);
		check(
			"keep=2 retains the 2 newest",
			!ids(selected).some((id) => id.startsWith("new")),
			JSON.stringify(ids(selected)),
		);
	}

	// 4) El filtro state restringe la selección a los states pedidos (honrando keep todavía).
	{
		const runs = [
			run("c1", "completed", "2026-06-01T00:00:03Z"),
			run("f1", "failed", "2026-06-01T00:00:02Z"),
			run("x1", "cancelled", "2026-06-01T00:00:01Z"),
		];
		const selected = selectRunsForCleanup(runs, { keep: 0, states: ["failed", "cancelled"], activeIds: empty });
		check(
			"state filter keeps only failed+cancelled",
			ids(selected).sort().join(",") === "f1,x1",
			JSON.stringify(ids(selected)),
		);
	}

	// 5) input vacío → selección vacía.
	check("empty input → []", selectRunsForCleanup([], { keep: 0, activeIds: empty }).length === 0);

	// 6) keep mayor que el conteo terminal → no se selecciona nada.
	{
		const runs = [run("t1", "completed", "2026-06-01T00:00:01Z"), run("t2", "failed", "2026-06-01T00:00:02Z")];
		check("keep >= count → []", selectRunsForCleanup(runs, { keep: 5, activeIds: empty }).length === 0);
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
