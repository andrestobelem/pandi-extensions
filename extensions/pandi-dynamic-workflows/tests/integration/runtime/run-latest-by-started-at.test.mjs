#!/usr/bin/env node
/**
 * Regresión: "latest" debe resolver por startedAt, no por mtime del directorio.
 *
 * Review Farley 2026-07-03, hallazgo #2 (High): getRunDirs ordena run dirs por
 * mtimeMs, y listRuns/resolveRun heredan ese orden. status.json se reescribe en cada
 * refresh de log()/resume/status, así que CUALQUIER escritura en un run dir VIEJO sube
 * su mtime por encima de runs más nuevos — y `latest` es el target default para resume,
 * view, cancel y delete. Cleanup (run-state.ts) ya ordena por startedAt; la resolución
 * default debe coincidir.
 *
 * Contrato fijado acá (run-view.ts):
 *   - listRuns devuelve runs ordenados por startedAt (newest first) incluso cuando un
 *     run dir viejo tiene mtime más nuevo.
 *   - resolveRun(ctx, undefined) — "latest" — devuelve el startedAt más nuevo.
 *   - Records con startedAt faltante/no parseable ordenan después de los fechados y no
 *     crashean el listado.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule, sdkStub } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const { check, counts } = createChecker();

async function makeRun(runsRoot, runId, startedAt) {
	const runDir = path.join(runsRoot, runId);
	await fs.mkdir(runDir, { recursive: true });
	await fs.writeFile(
		path.join(runDir, "status.json"),
		`${JSON.stringify({
			workflow: "w",
			scope: "project",
			runId,
			runDir,
			state: "completed",
			background: false,
			...(startedAt ? { startedAt } : {}),
			updatedAt: startedAt ?? "2026-01-01T00:00:00.000Z",
			elapsedMs: 1,
			agentCount: 0,
			logs: [],
		})}\n`,
		"utf8",
	);
	return runDir;
}

async function main() {
	const { url } = await buildExtension({
		name: "pi-dwf-latest-started-at",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "tui/run-view.ts"),
		outName: "run-view.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
	});
	const { listRuns, resolveRun } = await loadModule(url);
	check("listRuns exported", typeof listRuns === "function");
	check("resolveRun exported", typeof resolveRun === "function");

	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-latest-"));
	const runsRoot = path.join(project, ".pi", "workflows", "runs");
	const ctx = { cwd: project, isProjectTrusted: () => true };

	// Run VIEJO creado… luego B (startedAt más nuevo)… luego se reescribe status.json de A,
	// dando al dir VIEJO el mtime MÁS NUEVO (lo que hace cualquier refresh de log/status).
	const dirA = await makeRun(runsRoot, "2026-07-01T00-00-00-000Z-old-run", "2026-07-01T00:00:00.000Z");
	await makeRun(runsRoot, "2026-07-02T00-00-00-000Z-new-run", "2026-07-02T00:00:00.000Z");
	await new Promise((r) => setTimeout(r, 20));
	const statusA = path.join(dirA, "status.json");
	await fs.writeFile(statusA, await fs.readFile(statusA, "utf8"), "utf8");
	const future = new Date(Date.now() + 60_000);
	await fs.utimes(dirA, future, future);
	await fs.utimes(statusA, future, future);

	const runs = await listRuns(ctx);
	check("both runs listed", runs.length === 2, JSON.stringify(runs.map((r) => r.runId)));
	check(
		"listRuns orders by startedAt, not mtime",
		runs[0]?.runId === "2026-07-02T00-00-00-000Z-new-run",
		JSON.stringify(runs.map((r) => r.runId)),
	);
	const latest = await resolveRun(ctx, undefined);
	check("latest = newest startedAt", latest.runId === "2026-07-02T00-00-00-000Z-new-run", latest.runId);

	// startedAt faltante: ordena después de runs fechados, sin crash.
	await makeRun(runsRoot, "1999-no-started-at", undefined);
	const withUndated = await listRuns(ctx);
	check("undated run listed without crashing", withUndated.length === 3);
	check(
		"undated run sorts after dated ones",
		withUndated[withUndated.length - 1]?.runId === "1999-no-started-at",
		JSON.stringify(withUndated.map((r) => r.runId)),
	);

	console.log(`\nTOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
