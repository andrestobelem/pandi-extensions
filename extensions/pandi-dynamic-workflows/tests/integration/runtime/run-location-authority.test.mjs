#!/usr/bin/env node
/**
 * Regresión de autoridad de ubicación: un `result.json` descubierto dentro del
 * root de runs puede contener un `runDir` persistido obsoleto o manipulado, pero
 * esa metadata nunca debe dirigir E/S posterior (view, report, resume o cleanup).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createChecker } from "../../../../shared/test/harness.mjs";
import { buildDwfExtension, buildDwfModule } from "../dwf-test-support.mjs";

const { check, counts } = createChecker();

const WORKFLOW_SOURCE = [
	"export const meta = { name: 'authority-resume', description: 'run location authority probe' };",
	"export default async function main() { return args; }",
].join("\n");

function makeCtx(cwd) {
	return {
		mode: "print",
		hasUI: false,
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		ui: {
			theme: { fg: (_color, value) => value },
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => true,
			select: async () => undefined,
			editor: async (_title, initial = "") => initial,
			custom: async () => undefined,
			getEditorComponent: () => undefined,
			setEditorComponent: () => {},
		},
		sessionManager: { getEntries: () => [] },
	};
}

function makePi() {
	const tools = new Map();
	return {
		pi: {
			registerTool: (definition) => tools.set(definition.name, definition),
			registerCommand: () => {},
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
	};
}

async function exists(file) {
	return await fs.stat(file).then(
		() => true,
		() => false,
	);
}

async function makeForgedRun(root, project, id, overrides = {}) {
	const discoveredRunDir = path.join(project, ".pi", "workflows", "runs", id);
	const externalRunDir = path.join(root, "outside-discovery", id);
	const workflow = overrides.workflow ?? "authority-resume";
	const workflowFile = path.join(project, ".pi", "workflows", `${workflow}.js`);
	await fs.mkdir(discoveredRunDir, { recursive: true });
	await fs.mkdir(externalRunDir, { recursive: true });
	await fs.mkdir(path.dirname(workflowFile), { recursive: true });
	await fs.writeFile(workflowFile, `${WORKFLOW_SOURCE}\n`, "utf8");
	const record = {
		workflow,
		scope: "project",
		file: workflowFile,
		runId: id,
		runDir: externalRunDir,
		ok: false,
		state: overrides.state ?? "failed",
		background: false,
		startedAt: overrides.startedAt ?? "2026-07-11T12:00:00.000Z",
		endedAt: overrides.endedAt ?? "2026-07-11T12:00:01.000Z",
		elapsedMs: 1000,
		agentCount: 0,
		logs: [],
		error: "fixture failure",
	};
	const serialized = `${JSON.stringify(record, null, 2)}\n`;
	await fs.writeFile(path.join(discoveredRunDir, "result.json"), serialized, "utf8");
	await fs.writeFile(path.join(externalRunDir, "result.json"), serialized, "utf8");
	await fs.writeFile(path.join(discoveredRunDir, "actual-only.txt"), "actual\n", "utf8");
	await fs.writeFile(path.join(externalRunDir, "external-only.txt"), "external\n", "utf8");
	return { discoveredRunDir, externalRunDir, record, serialized };
}

async function main() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-run-authority-"));
	const project = path.join(root, "project");
	try {
		const { url } = await buildDwfExtension({ name: "pi-dwf-run-location-authority" });
		const extensionModule = await import(url);
		const { pi, tools } = makePi();
		const extension = extensionModule.default;
		(extension.activate ?? extension)(pi, makeCtx(project));
		const tool = tools.get("dynamic_workflow");
		const ctx = makeCtx(project);
		const execute = (params) =>
			tool.execute("run-location-authority", params, new AbortController().signal, undefined, ctx);

		const viewFixture = await makeForgedRun(root, project, "authority-view");
		const view = await execute({ action: "view", name: viewFixture.record.runId });
		const viewText = view.content.map((part) => part.text ?? "").join("\n");
		check("view reads files from the discovered run directory", viewText.includes("actual-only.txt"), viewText);
		check("view never reads files from persisted record.runDir", !viewText.includes("external-only.txt"), viewText);

		const reportFixture = await makeForgedRun(root, project, "authority-report", {
			startedAt: "2026-07-11T12:01:00.000Z",
		});
		await execute({ action: "report", name: reportFixture.record.runId });
		check(
			"report is written under the discovered run directory",
			await exists(path.join(reportFixture.discoveredRunDir, "report.html")),
		);
		check(
			"report never writes under persisted record.runDir",
			!(await exists(path.join(reportFixture.externalRunDir, "report.html"))),
		);

		const resumeFixture = await makeForgedRun(root, project, "authority-resume", {
			startedAt: "2026-07-11T12:02:00.000Z",
		});
		await fs.writeFile(path.join(resumeFixture.discoveredRunDir, "input.json"), '{"source":"discovered"}\n', "utf8");
		await fs.writeFile(path.join(resumeFixture.externalRunDir, "input.json"), '{"source":"external"}\n', "utf8");
		const externalResultBefore = await fs.readFile(path.join(resumeFixture.externalRunDir, "result.json"), "utf8");
		const resumed = await execute({
			action: "resume",
			name: resumeFixture.record.runId,
			maxAgents: 1,
			timeoutMs: 30_000,
		});
		check(
			"resume reads input from the discovered run directory",
			resumed.details?.result?.output?.source === "discovered",
			JSON.stringify(resumed.details?.result?.output),
		);
		check(
			"resume never rewrites persisted record.runDir",
			(await fs.readFile(path.join(resumeFixture.externalRunDir, "result.json"), "utf8")) === externalResultBefore &&
				!(await exists(path.join(resumeFixture.externalRunDir, "agents"))),
		);

		const cleanupModule = await buildDwfModule({
			name: "pi-dwf-run-location-authority-cleanup",
			relPath: "lifecycle/cleanup.ts",
			outName: "cleanup.mjs",
		});
		const { cleanupWorkflowRuns, deleteWorkflowRun } = await import(cleanupModule.url);

		const deleteFixture = await makeForgedRun(root, project, "authority-delete", {
			startedAt: "2026-07-11T12:03:00.000Z",
		});
		await deleteWorkflowRun(ctx, deleteFixture.record.runId);
		check("delete removes the discovered run directory", !(await exists(deleteFixture.discoveredRunDir)));
		check("delete preserves persisted record.runDir", await exists(deleteFixture.externalRunDir));

		const cleanupFixture = await makeForgedRun(root, project, "authority-cleanup", {
			state: "completed",
			startedAt: "2026-07-11T12:04:00.000Z",
		});
		await cleanupWorkflowRuns(ctx, { keep: 0, states: ["completed"] });
		check("cleanup removes the discovered run directory", !(await exists(cleanupFixture.discoveredRunDir)));
		check("cleanup preserves persisted record.runDir", await exists(cleanupFixture.externalRunDir));
	} finally {
		await fs.rm(root, { recursive: true, force: true }).catch(() => {});
	}

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) process.exit(1);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
