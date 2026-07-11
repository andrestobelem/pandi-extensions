#!/usr/bin/env node
/**
 * Bundles de test (esbuild sin copyDirs) omiten scaffolds/ al lado del .mjs.
 * listWorkflows y dashboard open no deben fallar: builtin scaffolds ausentes = lista vacía
 * de scaffolds, no throw en discovery.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createChecker } from "../../../../shared/test/harness.mjs";
import { buildDwfExtension, REPO_ROOT } from "../dwf-test-support.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _EXTENSION_ROOT = path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows");
const { check, counts } = createChecker();

async function _buildExtensionWithoutScaffolds() {
	return await buildDwfExtension({ name: "pandi-dwf-no-scaffolds", customEditor: "full" });
}

function makePi() {
	const commands = new Map();
	const handlers = new Map();
	const tools = new Map();
	const pi = {
		events: { on: () => {} },
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: (name, opts) => commands.set(name, opts),
		registerShortcut: () => {},
		on: (event, handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		appendEntry: () => {},
		sendUserMessage: () => {},
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => {},
		exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
	};
	return { pi, commands, handlers, tools };
}

function makeCtx(cwd) {
	const theme = { fg: (_c, v) => v, bg: (_c, v) => v, bold: (v) => v };
	return {
		mode: "tui",
		hasUI: true,
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		ui: {
			theme,
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => true,
			select: async () => undefined,
			editor: async (_t, initial = "") => initial,
			getEditorComponent: () => undefined,
			setEditorComponent: () => {},
			custom: async () => null,
		},
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [],
			getSessionId: () => "sid",
			getSessionFile: () => path.join(cwd, ".pi", "sessions", "s.jsonl"),
			getSessionName: () => "Test",
		},
	};
}

async function main() {
	const { url } = await buildDwfExtension({ name: "pandi-dwf-no-scaffolds", customEditor: "full" });
	const mod = await import(url);
	const { pi, commands, handlers, tools } = makePi();
	mod.default(pi);

	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pandi-dwf-no-scaffolds-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	const ctx = makeCtx(project);
	for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);

	const tool = tools.get("dynamic_workflow");
	const listed = await tool.execute(
		"resolve-missing-scaffolds",
		{ action: "list" },
		new AbortController().signal,
		undefined,
		ctx,
	);
	check("list action succeeds without scaffolds dir", Array.isArray(listed.details.workflows), JSON.stringify(listed));
	check(
		"list omits builtin scaffolds when assets are absent",
		!listed.details.workflows.some((wf) => wf.origin === "scaffold"),
		JSON.stringify(listed.details.workflows.map((wf) => wf.name)),
	);

	let scaffoldLoadError = "";
	try {
		await tool.execute(
			"resolve-missing-scaffolds-load",
			{ action: "scaffold", name: "contract-gate" },
			new AbortController().signal,
			undefined,
			ctx,
		);
	} catch (err) {
		scaffoldLoadError = err instanceof Error ? err.message : String(err);
	}
	check(
		"scaffold with name fails when assets are absent",
		scaffoldLoadError.includes("Workflow scaffold missing for pattern contract-gate"),
		scaffoldLoadError || "(no error)",
	);

	const catalog = await tool.execute(
		"resolve-missing-scaffolds-catalog",
		{ action: "scaffold" },
		new AbortController().signal,
		undefined,
		ctx,
	);
	check(
		"scaffold catalog still lists patterns without assets",
		Array.isArray(catalog.details.patterns) && catalog.details.patterns.length > 0,
		JSON.stringify(catalog.details.patterns?.length),
	);
	check(
		"default scaffold omitted when assets are absent",
		catalog.details.scaffold === undefined,
		String(catalog.details.scaffold),
	);

	let dashboardOpened = false;
	ctx.ui.custom = async (factory) => {
		dashboardOpened = true;
		const tui = { terminal: { rows: 30, columns: 100 }, requestRender: () => {} };
		const done = () => {};
		factory(tui, ctx.ui.theme, {}, done);
		return null;
	};
	await commands.get("workflow").handler("dashboard", ctx);
	check("dashboard open reaches ui.custom without scaffolds dir", dashboardOpened, String(dashboardOpened));

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
