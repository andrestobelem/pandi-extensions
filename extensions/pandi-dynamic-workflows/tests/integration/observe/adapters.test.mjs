/**
 * run-report-adapters — fija las superficies user-facing del run report (design
 * record §6.5, run bd039ef9): la acción `report` de la tool dynamic_workflow y el
 * slash command `/workflow report` resuelven un run (id explícito o latest), escriben
 * un report.html autocontenido DENTRO del run dir (para que funcionen los links relativos
 * a artifacts), y countRunArtifacts nunca cuenta el reporte mismo como artifact del run.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

const { check, counts } = createChecker();

function makePi() {
	const tools = new Map();
	const commands = new Map();
	return {
		pi: {
			registerTool: (def) => tools.set(def.name, def),
			registerCommand: (name, def) => commands.set(name, def),
			registerShortcut: () => {},
			on: () => {},
			appendEntry: () => {},
			sendUserMessage: () => {},
			getThinkingLevel: () => undefined,
			getActiveTools: () => [],
			getAllTools: () => [...tools.values()],
			setActiveTools: () => {},
			exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
		},
		tools,
		commands,
	};
}

function makeCtx(cwd) {
	return {
		mode: "print",
		hasUI: false,
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		ui: {
			theme: { fg: (_c, v) => v },
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => true,
			select: async () => undefined,
			editor: async (_t, i = "") => i,
			custom: async () => undefined,
			getEditorComponent: () => undefined,
			setEditorComponent: () => {},
		},
		sessionManager: { getEntries: () => [] },
	};
}

async function makeRunDir(project, runId, { startedAt = "2026-01-01T00:00:00.000Z" } = {}) {
	const runDir = path.join(project, ".pi", "workflows", "runs", runId);
	await fs.mkdir(path.join(runDir, "agents"), { recursive: true });
	const updatedAt = new Date(Date.parse(startedAt) + 60_000).toISOString();
	const logAt = new Date(Date.parse(startedAt) + 1_000).toISOString();
	const status = {
		workflow: "adapter-demo",
		scope: "project",
		file: path.join(project, ".pi", "workflows", "adapter-demo.js"),
		runId,
		runDir,
		state: "completed",
		background: true,
		active: false,
		startedAt,
		updatedAt,
		endedAt: updatedAt,
		elapsedMs: 60000,
		agentCount: 1,
		logs: [{ time: logAt, message: "phase: solo" }],
	};
	await fs.writeFile(path.join(runDir, "status.json"), JSON.stringify(status));
	await fs.writeFile(
		path.join(runDir, "events.jsonl"),
		`${JSON.stringify({ type: "agent", id: 1, name: "solo", ok: true, state: "completed", output: "hello world" })}\n`,
	);
	await fs.writeFile(path.join(runDir, "agents", "0001-solo.md"), "# solo\n\n## Prompt\n\ndo the thing\n");
	return runDir;
}

const settle = (p) =>
	p.then(
		(v) => ({ ok: true, v }),
		(e) => ({ ok: false, msg: String(e?.message ?? e) }),
	);

async function main() {
	const { url } = await sharedBuildExtension({
		name: "pi-run-report-adapters",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "index.ts"),
		outName: "dynamic-workflows.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
	});
	const mod = await import(url);
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-run-report-adapters-"));
	const { pi, tools, commands } = makePi();
	(mod.default.activate ?? mod.default)(pi, makeCtx(project));
	const tool = tools.get("dynamic_workflow");
	const ctx = makeCtx(project);

	// La acción forma parte del schema de la tool.
	check("tool registered", !!tool);

	const oldRunId = "2026-01-01T00-00-00-000Z-adapter-demo-aaaa1111";
	const latestRunId = "2026-01-02T00-00-00-000Z-adapter-demo-bbbb2222";
	const runDir = await makeRunDir(project, oldRunId, { startedAt: "2026-01-01T00:00:00.000Z" });
	const latestRunDir = await makeRunDir(project, latestRunId, { startedAt: "2026-01-02T00:00:00.000Z" });

	// 1) Tool action=report con run id explícito escribe <runDir>/report.html.
	const explicit = await settle(
		tool.execute("tc-report-1", { action: "report", name: oldRunId }, new AbortController().signal, undefined, ctx),
	);
	check("action=report succeeds", explicit.ok === true, explicit.ok ? "" : explicit.msg);
	const reportPath = path.join(runDir, "report.html");
	const latestReportPath = path.join(latestRunDir, "report.html");
	const html = await fs.readFile(reportPath, "utf8").catch(() => undefined);
	check("report.html written inside the run dir", typeof html === "string");
	check("report is a full document", (html ?? "").startsWith("<!doctype html>"));
	check("report names the workflow", (html ?? "").includes("adapter-demo"));
	check(
		"report links the agent artifact through the static viewer",
		(html ?? "").includes('href="artifact-viewer.html#artifact-'),
	);
	const viewerPath = path.join(runDir, "artifact-viewer.html");
	const viewerHtml = await fs.readFile(viewerPath, "utf8").catch(() => undefined);
	check("artifact-viewer.html written inside the run dir", typeof viewerHtml === "string");
	check("artifact viewer includes the agent artifact content", (viewerHtml ?? "").includes("do the thing"));
	check("tool response mentions the output path", explicit.ok && JSON.stringify(explicit.v).includes("report.html"));

	// 2) action=report sin name resuelve el run LATEST entre múltiples candidatos.
	await fs.rm(reportPath, { force: true });
	await fs.rm(latestReportPath, { force: true });
	const latest = await settle(
		tool.execute("tc-report-2", { action: "report" }, new AbortController().signal, undefined, ctx),
	);
	check("action=report defaults to latest run", latest.ok === true, latest.ok ? "" : latest.msg);
	check(
		"latest run report written",
		await fs.access(latestReportPath).then(
			() => true,
			() => false,
		),
	);
	check(
		"older run report not written by latest default",
		await fs.access(reportPath).then(
			() => false,
			() => true,
		),
	);

	// 3) action=report watch:true en un run terminal escribe una vez y no agrega refresh.
	await fs.rm(reportPath, { force: true });
	await fs.rm(latestReportPath, { force: true });
	const watchedTerminal = await settle(
		tool.execute("tc-report-3", { action: "report", watch: true }, new AbortController().signal, undefined, ctx),
	);
	check(
		"action=report watch:true succeeds on terminal run",
		watchedTerminal.ok === true,
		watchedTerminal.ok ? "" : watchedTerminal.msg,
	);
	const watchedHtml = await fs.readFile(latestReportPath, "utf8").catch(() => undefined);
	check("watched terminal report written", typeof watchedHtml === "string");
	check("watched terminal report has no meta refresh", !/http-equiv="refresh"/.test(watchedHtml ?? ""));
	check(
		"tool watch response reports one write",
		watchedTerminal.ok && JSON.stringify(watchedTerminal.v).includes("writes: 1"),
	);

	// 4) /workflow report <id> pasa por la superficie slash.
	await fs.rm(reportPath, { force: true });
	const workflowCommand = commands.get("workflow");
	check("/workflow command registered", !!workflowCommand);
	const slash = await settle(
		Promise.resolve(
			workflowCommand.handler
				? workflowCommand.handler(`report ${oldRunId}`, ctx)
				: commands.get("workflow")(`report ${oldRunId}`, ctx),
		),
	);
	check("/workflow report succeeds", slash.ok === true, slash.ok ? "" : slash.msg);
	check(
		"slash surface wrote the report",
		await fs.access(reportPath).then(
			() => true,
			() => false,
		),
	);

	// 5) countRunArtifacts nunca cuenta los viewers generados.
	check("countRunArtifacts exported for the pin", typeof mod.countRunArtifacts === "function");
	if (typeof mod.countRunArtifacts === "function") {
		const withViewers = await mod.countRunArtifacts(runDir);
		await fs.rm(reportPath, { force: true });
		await fs.rm(viewerPath, { force: true });
		const withoutViewers = await mod.countRunArtifacts(runDir);
		check(
			"report.html and artifact-viewer.html excluded from artifact count",
			withViewers === withoutViewers,
			`${withViewers} vs ${withoutViewers}`,
		);
	}

	console.log(`\nTOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
