#!/usr/bin/env node
/**
 * run-report-watch — pins issue #29: watched run reports are regenerated
 * server-side while a run is running, written atomically, and the browser meta
 * refresh exists only in running watched snapshots (never in the final report).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createChecker } from "../../../../shared/test/harness.mjs";
import { buildDwfModule } from "../dwf-test-support.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { check, counts } = createChecker();

async function buildModule(src, outName, name) {
	const { url } = await buildDwfModule({ name, relPath: src, outName });
	return await import(url);
}

function baseModel(extra = {}) {
	return {
		workflow: "watch-demo",
		runId: "run-watch-demo",
		state: "running",
		liveness: "verified",
		generatedAt: "2026-01-02T00:00:00.000Z",
		logs: [],
		phases: [],
		agents: [],
		artifacts: [],
		missingFiles: [],
		clampNotes: [],
		...extra,
	};
}

function baseStatus(runDir, extra = {}) {
	return {
		workflow: "watch-demo",
		scope: "project",
		file: path.join(runDir, "workflow.js"),
		runId: "run-watch-demo",
		runDir,
		state: "running",
		background: true,
		active: true,
		startedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:01.000Z",
		elapsedMs: 1000,
		agentCount: 0,
		logs: [],
		...extra,
	};
}

async function readStatusFile(runDir) {
	return JSON.parse(await fs.readFile(path.join(runDir, "status.json"), "utf8"));
}

async function main() {
	const htmlMod = await buildModule("observe/html.ts", "run-report-html.mjs", "run-report-watch-html");
	const writer = await buildModule("observe/writer.ts", "run-report-writer.mjs", "run-report-watch-writer");
	const handlers = await buildModule(
		"surface/command-handlers.ts",
		"command-handlers.mjs",
		"run-report-watch-handlers",
	);

	check("buildRunReportHtml exported", typeof htmlMod.buildRunReportHtml === "function");
	check("watchRunReport exported", typeof writer.watchRunReport === "function");
	check("parseRunReportArgs exported", typeof handlers.parseRunReportArgs === "function");

	const watchedRunning = htmlMod.buildRunReportHtml(baseModel({ autoRefreshSeconds: 2 }));
	check("watched running report emits meta refresh", /http-equiv="refresh" content="2"/.test(watchedRunning));
	check("watched running report explains auto-refresh", watchedRunning.includes("Auto-refresh"));

	const completed = htmlMod.buildRunReportHtml(baseModel({ state: "completed", autoRefreshSeconds: 2 }));
	check("terminal report never emits meta refresh", !/http-equiv="refresh"/.test(completed));

	const staticRunning = htmlMod.buildRunReportHtml(baseModel());
	check("static running snapshot keeps v1 no-refresh contract", !/http-equiv="refresh"/.test(staticRunning));

	{
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "run-report-watch-"));
		try {
			await fs.writeFile(path.join(dir, "workflow.js"), "export default async function main() {}\n");
			const running = baseStatus(dir);
			await fs.writeFile(path.join(dir, "status.json"), JSON.stringify(running));
			const writes = [];
			const result = await writer.watchRunReport(running, {
				intervalMs: 20,
				readStatus: readStatusFile,
				onWrite: async (_result, html) => {
					writes.push(html);
					if (writes.length === 1) {
						await fs.writeFile(
							path.join(dir, "status.json"),
							JSON.stringify(
								baseStatus(dir, {
									state: "completed",
									active: false,
									updatedAt: "2026-01-01T00:00:02.000Z",
									endedAt: "2026-01-01T00:00:02.000Z",
									elapsedMs: 2000,
								}),
							),
						);
					}
				},
			});
			check("watch loop stops on terminal state", result.state === "completed", JSON.stringify(result));
			check("watch loop wrote running + final snapshots", result.iterations === 2 && writes.length === 2);
			check("first watched snapshot refreshes", /http-equiv="refresh"/.test(writes[0] ?? ""));
			const finalHtml = await fs.readFile(path.join(dir, "report.html"), "utf8");
			check("final report removes meta refresh", !/http-equiv="refresh"/.test(finalHtml));
			const leftovers = (await fs.readdir(dir)).filter(
				(name) => name.startsWith("report.html.") && name.endsWith(".tmp"),
			);
			check("atomic temp siblings cleaned up", leftovers.length === 0, leftovers.join(", "));
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}

	{
		const latest = handlers.parseRunReportArgs("latest --watch -o .pi/tmp/x.html");
		check(
			"parser treats latest as default",
			latest.runId === undefined && latest.watch && latest.outPath === ".pi/tmp/x.html",
		);
		const explicit = handlers.parseRunReportArgs("2026-run-id -o x.html --watch");
		check(
			"parser handles explicit id with reordered flags",
			explicit.runId === "2026-run-id" && explicit.watch && explicit.outPath === "x.html",
		);
		const watchLatest = handlers.parseRunReportArgs("--watch");
		check("parser allows watch latest", watchLatest.runId === undefined && watchLatest.watch);
		const missingOut = handlers.parseRunReportArgs("run-1 --out --watch");
		check("parser detects missing output path", missingOut.missingOutPath === true);
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
