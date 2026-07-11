#!/usr/bin/env node
/**
 * run-view: el cap de 80 files de listRunFiles no tenía remainder visible en formatRunView.
 *
 * El pathway de run-report ya resuelve esto — listArtifacts de run-report-collector.ts
 * devuelve tanto la lista cappeada COMO un count `omitted`, y run-report-html.ts:402
 * renderiza un mensaje visible "Clamp: N more files not listed." cuando ese count es truthy.
 * En cambio, listRunFiles de run-view.ts truncaba silenciosamente en 80 files (un `string[]`
 * pelado), y la sección "## Files / artifacts" de formatRunView renderizaba la lista truncada
 * sin indicar que se había omitido algo.
 *
 * Pinea:
 *   1. listRunFiles(dir) sobre un run dir con > 80 files devuelve tanto la lista `files`
 *      cappeada COMO un count `omitted` no-cero.
 *   2. La sección "## Files / artifacts" de formatRunView muestra una línea remainder visible
 *      "N more files not listed" para el mismo run dir.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, loadModule } from "../../../../shared/test/harness.mjs";
import { buildDwfModule } from "../dwf-test-support.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const { check, counts } = createChecker();

async function makeOverflowRunDir() {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-run-view-remainder-"));
	const runDir = path.join(tmp, "run-overflow");
	await fs.mkdir(runDir, { recursive: true });
	for (let i = 0; i < 90; i++) {
		await fs.writeFile(path.join(runDir, `artifact-${String(i).padStart(3, "0")}.txt`), "x");
	}
	return { tmp, runDir };
}

async function main() {
	const { url } = await buildDwfModule({
		name: "pi-dwf-file-remainder",
		relPath: "tui/run-view.ts",
		outName: "run-view.mjs",
	});
	const { listRunFiles, formatRunView } = await loadModule(url);
	check("listRunFiles is exported", typeof listRunFiles === "function");
	check("formatRunView is exported", typeof formatRunView === "function");

	const { tmp, runDir } = await makeOverflowRunDir();

	// 1) listRunFiles devuelve tanto la lista cappeada COMO el count omitted.
	const { files, omitted } = await listRunFiles(runDir);
	check("files capped at 80", files.length === 80, `files=${files.length}`);
	check("omitted is reported and > 0", omitted === 10, `omitted=${omitted}`);

	// 2) formatRunView renderiza una línea remainder visible en "## Files / artifacts".
	const run = {
		workflow: "overflow-wf",
		runId: "run-overflow",
		runDir,
		state: "completed",
		background: false,
		startedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:10:00.000Z",
		elapsedMs: 600000,
		agentCount: 0,
		logs: [],
	};
	const view = await formatRunView(run);
	const filesSection = view.split("## Files / artifacts")[1] ?? "";
	check("Files / artifacts section present", view.includes("## Files / artifacts"));
	check(
		"remainder line visible in Files / artifacts section",
		/more files not listed/i.test(filesSection),
		filesSection.slice(0, 400),
	);
	check("remainder line mentions the omitted count", filesSection.includes("10"), filesSection.slice(0, 400));

	await fs.rm(tmp, { recursive: true, force: true });

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
