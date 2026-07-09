#!/usr/bin/env node
/**
 * Contrato de distribución del Contract Gate.
 *
 * Pi packages no tienen un recurso nativo `workflows`: la extensión debe resolver su
 * ejecutable bundled como fallback global, sin copiarlo al agent-dir. El scaffold
 * homónimo sigue siendo una operación distinta (`action: "scaffold"`).
 */

import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const EXTENSION_ROOT = path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows");
const SCAFFOLDS_DIR = path.join(EXTENSION_ROOT, "scaffolds");
const BUNDLED_WORKFLOWS_DIR = path.join(EXTENSION_ROOT, "workflows");
const { check, counts } = createChecker();

async function buildExtension() {
	const copyDirs = { scaffolds: SCAFFOLDS_DIR };
	// El test corre rojo antes de crear el asset; cuando exista, lo copia junto al bundle,
	// igual que el layout producido por npm install.
	if (existsSync(BUNDLED_WORKFLOWS_DIR)) copyDirs.workflows = BUNDLED_WORKFLOWS_DIR;
	return await sharedBuildExtension({
		name: "pandi-dwf-bundled-contract-gate",
		src: path.join(EXTENSION_ROOT, "index.ts"),
		outName: "dynamic-workflows.mjs",
		copyDirs,
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

function makeCtx(cwd, hasUI = false) {
	return {
		mode: hasUI ? "tui" : "print",
		hasUI,
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

async function execute(tool, ctx, params) {
	return await tool.execute("bundled-contract-gate", params, new AbortController().signal, undefined, ctx);
}

const { url } = await buildExtension();
const project = await fs.mkdtemp(path.join(os.tmpdir(), "pandi-dwf-bundled-gate-project-"));
try {
	const { pi, tools } = makePi();
	const mod = await import(url);
	mod.default(pi);
	const tool = tools.get("dynamic_workflow");
	const ctx = makeCtx(project);

	const listed = await execute(tool, ctx, { action: "list" });
	const bundled = listed.details.workflows.find((workflow) => workflow.name === "contract-gate");
	check(
		"list exposes bundled contract-gate as a global workflow",
		bundled?.scope === "global",
		JSON.stringify(bundled),
	);
	check("list identifies the bundled workflow as read-only", bundled?.readOnly === true, JSON.stringify(bundled));

	const executable = await execute(tool, ctx, { action: "read", name: "contract-gate", scope: "global" });
	check(
		"read resolves bundled contract-gate outside the source project",
		executable.details.workflow?.readOnly === true &&
			executable.content?.[0]?.text?.includes('name: "contract-gate"'),
		JSON.stringify(executable.details.workflow),
	);

	const checked = await execute(tool, ctx, {
		action: "check",
		name: "contract-gate",
		scope: "global",
		input: { request: "x" },
	});
	check(
		"check accepts bundled contract-gate as an executable workflow",
		checked.details.preflight?.workflow?.readOnly === true &&
			checked.details.preflight?.checks?.includes("transformed workflow parses before run creation"),
		JSON.stringify(checked.details.preflight),
	);

	const scaffold = await execute(tool, ctx, { action: "scaffold", name: "contract-gate" });
	check(
		"scaffold contract-gate remains the separate design pattern",
		scaffold.details.pattern?.key === "contract-gate" && scaffold.content?.[0]?.text?.includes("export const meta"),
		JSON.stringify(scaffold.details.pattern),
	);

	let deleteError = "";
	try {
		await execute(tool, makeCtx(project, true), { action: "delete", name: "contract-gate", scope: "global" });
	} catch (error) {
		deleteError = error instanceof Error ? error.message : String(error);
	}
	check("delete refuses to mutate the bundled workflow", /read-only bundled workflow/i.test(deleteError), deleteError);
} finally {
	await fs.rm(project, { recursive: true, force: true });
}

if (counts.failed > 0) {
	console.error(`\n${counts.failed} checks FAILED:`);
	for (const failure of counts.failures) console.error(`- ${failure}`);
	process.exit(1);
}
console.log(`\n${counts.passed} checks passed`);
