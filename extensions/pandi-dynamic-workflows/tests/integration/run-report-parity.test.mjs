#!/usr/bin/env node
/**
 * run-report-parity — deferred pins from the run-report design record (§6.4).
 *
 * A single synthetic run is fed through the report collector, the Markdown/TUI
 * run view, and the dashboard monitor derivation. They should agree on the
 * facts users rely on: state, agent count/states, status-log precedence, and
 * cancelled-run derivation.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const { check, counts } = createChecker();

async function buildModule(src, outName, name) {
	const { url } = await buildExtension({
		name,
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", src),
		outName,
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
	});
	return loadModule(url);
}

function event(row) {
	return JSON.stringify(row);
}

async function makeRunDir() {
	const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-report-parity-"));
	await fs.mkdir(path.join(runDir, "agents"));
	const run = {
		workflow: "parity-wf",
		runId: "run-parity",
		runDir,
		file: path.join(runDir, "workflow.js"),
		ok: false,
		error: "Workflow cancelled.",
		background: true,
		startedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:06.000Z",
		endedAt: "2026-01-01T00:00:06.000Z",
		elapsedMs: 6000,
		agentCount: 2,
		logs: [{ time: "2026-01-01T00:00:02.000Z", message: "status-log-wins" }],
	};
	await fs.writeFile(path.join(runDir, "status.json"), JSON.stringify(run));
	await fs.writeFile(path.join(runDir, "workflow.js"), "export default async function main() {}\n");
	await fs.writeFile(
		path.join(runDir, "events.jsonl"),
		[
			event({ type: "log", time: "2026-01-01T00:00:01.000Z", message: "event-log-loses" }),
			event({ type: "agent", id: 1, name: "alpha", ok: true, state: "completed", elapsedMs: 1000 }),
			event({ type: "agent", id: 2, name: "beta", ok: false, code: 1, state: "failed", elapsedMs: 2000 }),
		].join("\n") + "\n",
	);
	return { runDir, run };
}

async function main() {
	const collector = await buildModule(
		"run-report-collector.ts",
		"run-report-collector.mjs",
		"run-report-parity-collector",
	);
	const runView = await buildModule("run-view.ts", "run-view.mjs", "run-report-parity-view");
	const dashboard = await buildModule(
		"dashboard-collectors.ts",
		"dashboard-collectors.mjs",
		"run-report-parity-dashboard",
	);
	check("collectRunReport exported", typeof collector.collectRunReport === "function");
	check("formatRunView exported", typeof runView.formatRunView === "function");
	check("deriveWorkflowMonitorModels exported", typeof dashboard.deriveWorkflowMonitorModels === "function");

	const { runDir, run } = await makeRunDir();
	const report = await collector.collectRunReport(runDir, { generatedAt: "2026-01-02T00:00:00.000Z" });
	const view = await runView.formatRunView(run);
	const [monitor] = await dashboard.deriveWorkflowMonitorModels([run]);

	check("collector derives cancelled state", report.state === "cancelled", `state=${report.state}`);
	check(
		"run view derives cancelled status",
		view.includes("Status: 🟨 cancelled"),
		view.split("\n").slice(0, 5).join(" | "),
	);
	check("monitor derives cancelled state", monitor?.state === "cancelled", `state=${monitor?.state}`);

	check("collector sees both agents", report.agents.length === 2, `agents=${report.agents.length}`);
	check("run view reports same agent count", view.includes("Agents: 2"));
	check("monitor sees same agent count", monitor?.agents.length === 2, `agents=${monitor?.agents.length}`);
	check("collector preserves failed agent state", report.agents.find((a) => a.name === "beta")?.state === "failed");
	check("run view preserves failed agent state", view.includes("#2 beta — failed"));
	check("monitor preserves failed agent state", monitor?.agents.find((a) => a.name === "beta")?.state === "failed");

	check(
		"collector prefers status logs over event logs",
		report.logs.some((l) => l.message === "status-log-wins"),
	);
	check(
		"collector excludes event fallback when status logs exist",
		!report.logs.some((l) => l.message === "event-log-loses"),
	);
	check("run view prefers status logs", view.includes("status-log-wins") && !view.includes("event-log-loses"));
	check(
		"monitor prefers status logs",
		monitor?.lastLog?.message === "status-log-wins",
		String(monitor?.lastLog?.message),
	);

	await fs.rm(runDir, { recursive: true, force: true });
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
