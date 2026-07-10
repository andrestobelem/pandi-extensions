#!/usr/bin/env node
/**
 * Regresión: el presupuesto maxAgents limita lanzamientos nuevos de CADA intento
 * de ejecución. Al reanudar, los IDs históricos se conservan para no clobber
 * artifacts, pero no pueden agotar por sí solos el presupuesto del intento nuevo.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, sdkStub } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const { check, counts } = createChecker();

const RESUME_WORKFLOW = [
	"export const meta = { name: 'resume-budget', description: 'resume budget probe' };",
	"const cached = await agent('CACHED', { label: 'cached' });",
	"let ready = false;",
	"try { await readFile('ready.txt'); ready = true; } catch {}",
	"if (!ready) throw new Error('not ready yet');",
	"const fresh = await agent('FRESH', { label: 'fresh', cache: false });",
	"return { cached, fresh };",
].join("\n");

const FRESH_CAP_WORKFLOW = [
	"export const meta = { name: 'fresh-cap', description: 'fresh cap probe' };",
	"await agent('FIRST', { cache: false });",
	"await agent('SECOND', { cache: false });",
	"return { unexpected: true };",
].join("\n");

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

const settle = (promise) =>
	promise.then(
		(value) => ({ ok: true, value }),
		(error) => ({ ok: false, message: String(error?.message ?? error) }),
	);

async function buildDynamicWorkflows() {
	return await buildExtension({
		name: "pi-dwf-resume-agent-budget",
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
}

async function main() {
	const previousCommand = process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND;
	let project;
	try {
		const { url } = await buildDynamicWorkflows();
		const mod = await import(url);
		const ext = mod.default;
		project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-resume-agent-budget-"));
		const workflows = path.join(project, ".pi", "workflows");
		await fs.mkdir(workflows, { recursive: true });
		await fs.writeFile(path.join(workflows, "resume-budget.js"), `${RESUME_WORKFLOW}\n`, "utf8");
		await fs.writeFile(path.join(workflows, "fresh-cap.js"), `${FRESH_CAP_WORKFLOW}\n`, "utf8");

		const fakePi = path.join(project, "fake-pi.mjs");
		await fs.writeFile(
			fakePi,
			`#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) + "\\n");\n`,
			{ mode: 0o755 },
		);
		process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = fakePi;

		const { pi, tools } = makePi();
		(ext.activate ?? ext)(pi, makeCtx(project));
		const tool = tools.get("dynamic_workflow");
		const ctx = makeCtx(project);
		const run = (params) => tool.execute("resume-agent-budget", params, new AbortController().signal, undefined, ctx);

		const initial = await settle(run({ action: "run", name: "resume-budget", maxAgents: 1, timeoutMs: 30_000 }));
		check("initial run fails after caching its first agent", initial.ok === false, initial.message);
		const runsDir = path.join(project, ".pi", "workflows", "runs");
		const resumeRunId = (await fs.readdir(runsDir)).find((entry) => entry.includes("resume-budget"));
		check("initial run directory exists", !!resumeRunId, String(resumeRunId));

		await fs.writeFile(path.join(project, "ready.txt"), "ready\n", "utf8");
		const resumed = await settle(run({ action: "resume", name: resumeRunId, maxAgents: 1, timeoutMs: 30_000 }));
		const resumedResult = resumed.value?.details?.result;
		check("resume succeeds with the same maxAgents budget", resumed.ok === true, resumed.message);
		check(
			"resume reuses the cached first agent and launches the fresh second agent",
			resumedResult?.output?.cached === "ok" && resumedResult?.output?.fresh === "ok",
			JSON.stringify(resumedResult?.output),
		);
		const agentFiles = resumedResult?.runDir ? await fs.readdir(path.join(resumedResult.runDir, "agents")) : [];
		check(
			"resume keeps unique artifact IDs without a third launch",
			agentFiles.some((name) => name.startsWith("0001-cached")) &&
				agentFiles.some((name) => name.startsWith("0002-fresh")) &&
				!agentFiles.some((name) => name.startsWith("0003-")),
			JSON.stringify(agentFiles),
		);

		const capped = await settle(run({ action: "run", name: "fresh-cap", maxAgents: 1, timeoutMs: 30_000 }));
		check(
			"fresh runs still reject a second uncached launch at maxAgents=1",
			capped.ok === false && /maxAgents=1/.test(capped.message),
			capped.message,
		);
	} finally {
		if (previousCommand === undefined) delete process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND;
		else process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = previousCommand;
		if (project) await fs.rm(project, { recursive: true, force: true });
	}

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) process.exit(1);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
