/**
 * run-report-adapters — pins the user-facing surfaces of the run report (design
 * record §6.5, run bd039ef9): the `report` dynamic_workflow tool action and the
 * `/workflow report` slash command resolve a run (explicit id or latest), write a
 * self-contained report.html INSIDE the run dir (so relative artifact links work),
 * and countRunArtifacts never counts the report itself as a run artifact.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

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

async function makeRunDir(project, runId) {
	const runDir = path.join(project, ".pi", "workflows", "runs", runId);
	await fs.mkdir(path.join(runDir, "agents"), { recursive: true });
	const status = {
		workflow: "adapter-demo",
		scope: "project",
		file: path.join(project, ".pi", "workflows", "adapter-demo.js"),
		runId,
		runDir,
		state: "completed",
		background: true,
		active: false,
		startedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:01:00.000Z",
		endedAt: "2026-01-01T00:01:00.000Z",
		elapsedMs: 60000,
		agentCount: 1,
		logs: [{ time: "2026-01-01T00:00:01.000Z", message: "phase: solo" }],
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

	// The action is part of the tool schema.
	check("tool registered", !!tool);

	const runDir = await makeRunDir(project, "2026-01-01T00-00-00-000Z-adapter-demo-aaaa1111");

	// 1) Tool action=report with explicit run id writes <runDir>/report.html.
	const explicit = await settle(
		tool.execute(
			"tc-report-1",
			{ action: "report", name: "2026-01-01T00-00-00-000Z-adapter-demo-aaaa1111" },
			new AbortController().signal,
			undefined,
			ctx,
		),
	);
	check("action=report succeeds", explicit.ok === true, explicit.ok ? "" : explicit.msg);
	const reportPath = path.join(runDir, "report.html");
	const html = await fs.readFile(reportPath, "utf8").catch(() => undefined);
	check("report.html written inside the run dir", typeof html === "string");
	check("report is a full document", (html ?? "").startsWith("<!doctype html>"));
	check("report names the workflow", (html ?? "").includes("adapter-demo"));
	check("report links the agent artifact relatively", (html ?? "").includes('href="agents/0001-solo.md"'));
	check("tool response mentions the output path", explicit.ok && JSON.stringify(explicit.v).includes("report.html"));

	// 2) action=report without a name resolves the LATEST run.
	await fs.rm(reportPath, { force: true });
	const latest = await settle(
		tool.execute("tc-report-2", { action: "report" }, new AbortController().signal, undefined, ctx),
	);
	check("action=report defaults to latest run", latest.ok === true, latest.ok ? "" : latest.msg);
	check(
		"latest run report written",
		await fs.access(reportPath).then(
			() => true,
			() => false,
		),
	);

	// 3) action=report watch:true on a terminal run writes once and does not add refresh.
	await fs.rm(reportPath, { force: true });
	const watchedTerminal = await settle(
		tool.execute("tc-report-3", { action: "report", watch: true }, new AbortController().signal, undefined, ctx),
	);
	check(
		"action=report watch:true succeeds on terminal run",
		watchedTerminal.ok === true,
		watchedTerminal.ok ? "" : watchedTerminal.msg,
	);
	const watchedHtml = await fs.readFile(reportPath, "utf8").catch(() => undefined);
	check("watched terminal report written", typeof watchedHtml === "string");
	check("watched terminal report has no meta refresh", !/http-equiv="refresh"/.test(watchedHtml ?? ""));
	check(
		"tool watch response reports one write",
		watchedTerminal.ok && JSON.stringify(watchedTerminal.v).includes("writes: 1"),
	);

	// 4) /workflow report <id> goes through the slash surface.
	await fs.rm(reportPath, { force: true });
	const workflowCommand = commands.get("workflow");
	check("/workflow command registered", !!workflowCommand);
	const slash = await settle(
		Promise.resolve(
			workflowCommand.handler
				? workflowCommand.handler("report 2026-01-01T00-00-00-000Z-adapter-demo-aaaa1111", ctx)
				: commands.get("workflow")("report 2026-01-01T00-00-00-000Z-adapter-demo-aaaa1111", ctx),
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

	// 5) countRunArtifacts never counts report.html itself.
	check("countRunArtifacts exported for the pin", typeof mod.countRunArtifacts === "function");
	if (typeof mod.countRunArtifacts === "function") {
		const withReport = await mod.countRunArtifacts(runDir);
		await fs.rm(reportPath, { force: true });
		const withoutReport = await mod.countRunArtifacts(runDir);
		check(
			"report.html excluded from artifact count",
			withReport === withoutReport,
			`${withReport} vs ${withoutReport}`,
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
