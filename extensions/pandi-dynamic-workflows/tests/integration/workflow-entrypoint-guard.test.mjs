#!/usr/bin/env node
/**
 * Regression: a workflow file whose CommonJS export is not a function must fail with
 * the documented entrypoint guardrail, not accidentally execute the injected
 * `workflow()` composition primitive as the entrypoint.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildExtension, createChecker, REPO_ROOT, sdkStub } from "../../../shared/test/harness.mjs";

const { check, counts } = createChecker();

async function buildDynamicWorkflows() {
	return await buildExtension({
		name: "pi-dwf-entrypoint-guard",
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

function makePi() {
	const tools = new Map();
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
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
	};
	return { pi, tools };
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

async function makeProject() {
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-entrypoint-guard-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	await fs.writeFile(path.join(project, ".pi", "workflows", "bad-entrypoint.js"), "module.exports = {};\n", "utf8");
	return project;
}

async function main() {
	const { url } = await buildDynamicWorkflows();
	const mod = await import(url);
	const ext = mod.default;
	const project = await makeProject();
	const { pi, tools } = makePi();
	(ext.activate ?? ext)(pi, makeCtx(project));
	const tool = tools.get("dynamic_workflow");
	const ctx = makeCtx(project);

	try {
		let error = "";
		try {
			await tool.execute(
				"tc-entrypoint-guard",
				{ action: "run", name: "bad-entrypoint", timeoutMs: 30_000 },
				new AbortController().signal,
				undefined,
				ctx,
			);
		} catch (err) {
			error = err instanceof Error ? err.stack || err.message : String(err);
		}
		check("invalid workflow export fails", error.length > 0, "run unexpectedly succeeded");
		check(
			"invalid workflow export reports the documented guardrail",
			error.includes("Workflow must export a function"),
			error,
		);
		check(
			"invalid workflow export does not call the composition primitive",
			!error.includes("DataCloneError"),
			error,
		);
		check("invalid workflow export does not resolve a sub-workflow", !error.includes("Workflow not found"), error);
	} finally {
		await fs.rm(project, { recursive: true, force: true });
	}

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		console.error(counts.failures.map((f) => `- ${f}`).join("\n"));
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
