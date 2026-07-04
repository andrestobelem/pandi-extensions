#!/usr/bin/env node
/**
 * run-view: listRunFiles' 80-file cap has no visible remainder in formatRunView.
 *
 * The run-report pathway already solves this — run-report-collector.ts's
 * listArtifacts returns both the capped list AND an `omitted` count, and
 * run-report-html.ts:402 renders a visible "Clamp: N more files not listed."
 * message when that count is truthy. run-view.ts's listRunFiles instead
 * silently truncated at 80 files (a bare `string[]`), and formatRunView's
 * "## Files / artifacts" section rendered the truncated list with no
 * indication that anything was omitted.
 *
 * Pins:
 *   1. listRunFiles(dir) on a run dir with > 80 files returns both the
 *      capped `files` list AND a non-zero `omitted` count.
 *   2. formatRunView's "## Files / artifacts" section surfaces a visible
 *      "N more files not listed" remainder line for the same run dir.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
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
	const { url } = await buildExtension({
		name: "pi-dwf-file-remainder",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "run-view.ts"),
		outName: "run-view.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
	});
	const { listRunFiles, formatRunView } = await loadModule(url);
	check("listRunFiles is exported", typeof listRunFiles === "function");
	check("formatRunView is exported", typeof formatRunView === "function");

	const { tmp, runDir } = await makeOverflowRunDir();

	// 1) listRunFiles returns both the capped list AND the omitted count.
	const { files, omitted } = await listRunFiles(runDir);
	check("files capped at 80", files.length === 80, `files=${files.length}`);
	check("omitted is reported and > 0", omitted === 10, `omitted=${omitted}`);

	// 2) formatRunView renders a visible remainder line in "## Files / artifacts".
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
