#!/usr/bin/env node
/**
 * Contrato de distribución del Contract Gate.
 *
 * Pi packages no tienen un recurso nativo `workflows`: Dynamic Workflows usa el
 * scaffold canónico como fallback read-only, sin copiarlo al agent-dir ni mantener
 * una variante ejecutable duplicada.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const EXTENSION_ROOT = path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows");
const SCAFFOLDS_DIR = path.join(EXTENSION_ROOT, "scaffolds");
const CANONICAL_CONTRACT_GATE = path.join(SCAFFOLDS_DIR, "contract-gate.js");
const { check, counts } = createChecker();

async function buildExtension() {
	return await sharedBuildExtension({
		name: "pandi-dwf-scaffold-contract-gate",
		src: path.join(EXTENSION_ROOT, "index.ts"),
		outName: "dynamic-workflows.mjs",
		copyDirs: { scaffolds: SCAFFOLDS_DIR },
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
	return await tool.execute("scaffold-contract-gate", params, new AbortController().signal, undefined, ctx);
}

const { url } = await buildExtension();
const project = await fs.mkdtemp(path.join(os.tmpdir(), "pandi-dwf-bundled-gate-project-"));
try {
	const { pi, tools } = makePi();
	const mod = await import(url);
	mod.default(pi);
	const tool = tools.get("dynamic_workflow");
	const ctx = makeCtx(project);

	const source = await fs.readFile(CANONICAL_CONTRACT_GATE, "utf8");
	const listed = await execute(tool, ctx, { action: "list" });
	const builtin = listed.details.workflows.find((workflow) => workflow.name === "contract-gate");
	check(
		"list exposes canonical contract-gate scaffold as a global workflow",
		builtin?.scope === "global" && builtin?.path.endsWith("scaffolds/contract-gate.js"),
		JSON.stringify(builtin),
	);
	check(
		"list identifies the canonical scaffold workflow as read-only",
		builtin?.readOnly === true,
		JSON.stringify(builtin),
	);
	const factory = listed.details.workflows.find((workflow) => workflow.name === "workflow-factory");
	check(
		"list exposes composed scaffolds needed by contract-gate preflight",
		factory?.origin === "scaffold" && factory?.readOnly === true,
		JSON.stringify(factory),
	);

	const executable = await execute(tool, ctx, { action: "read", name: "contract-gate", scope: "global" });
	check(
		"read resolves the canonical scaffold outside the source project",
		executable.details.workflow?.readOnly === true &&
			executable.details.workflow?.path.endsWith("scaffolds/contract-gate.js"),
		JSON.stringify(executable.details.workflow),
	);
	check(
		"read returns the exact source served by action=scaffold",
		executable.details.code === source,
		executable.details.code,
	);

	const checked = await execute(tool, ctx, {
		action: "check",
		name: "contract-gate",
		scope: "global",
		input: { request: "x" },
	});
	check(
		"check accepts the canonical scaffold as an executable workflow",
		checked.details.preflight?.workflow?.path.endsWith("scaffolds/contract-gate.js") &&
			checked.details.preflight?.checks?.includes("transformed workflow parses before run creation"),
		JSON.stringify(checked.details.preflight),
	);

	const scaffold = await execute(tool, ctx, { action: "scaffold", name: "contract-gate" });
	check(
		"action=scaffold returns the same canonical source",
		scaffold.details.pattern?.key === "contract-gate" && scaffold.content?.[0]?.text === source,
		JSON.stringify(scaffold.details.pattern),
	);

	let projectScopeError = "";
	try {
		await execute(tool, ctx, { action: "read", name: "contract-gate", scope: "project" });
	} catch (error) {
		projectScopeError = error instanceof Error ? error.message : String(error);
	}
	check(
		"project scope does not jump to the builtin scaffold",
		/Workflow not found/.test(projectScopeError),
		projectScopeError,
	);

	const projectWorkflowPath = path.join(project, ".pi", "workflows", "contract-gate.js");
	await fs.mkdir(path.dirname(projectWorkflowPath), { recursive: true });
	await fs.writeFile(
		projectWorkflowPath,
		"export default async function workflow() { return { source: 'project' }; }\n",
		"utf8",
	);
	const projectOverride = await execute(tool, ctx, { action: "read", name: "contract-gate" });
	check(
		"project workflow takes precedence over the canonical scaffold",
		projectOverride.details.workflow?.scope === "project" &&
			projectOverride.details.workflow?.path.endsWith("/.pi/workflows/contract-gate.js") &&
			projectOverride.details.workflow?.readOnly !== true,
		JSON.stringify(projectOverride.details.workflow),
	);

	let deleteError = "";
	try {
		await execute(tool, makeCtx(project, true), { action: "delete", name: "contract-gate", scope: "global" });
	} catch (error) {
		deleteError = error instanceof Error ? error.message : String(error);
	}
	check(
		"delete refuses to mutate the canonical scaffold workflow",
		/read-only.*workflow/i.test(deleteError),
		deleteError,
	);
} finally {
	await fs.rm(project, { recursive: true, force: true });
}

if (counts.failed > 0) {
	console.error(`\n${counts.failed} checks FAILED:`);
	for (const failure of counts.failures) console.error(`- ${failure}`);
	process.exit(1);
}
console.log(`\n${counts.passed} checks passed`);
