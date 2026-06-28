#!/usr/bin/env node
/**
 * Behavioral regression test for the Ultracode router indicator on the editor's
 * top border (the violet prompt "rayita" line).
 *
 * Observable contract:
 *   - When Ultracode always-on is enabled, the editor's top border embeds an
 *     "ultracode auto" label while still rendering as a border (keeps the ─ glyphs).
 *   - The label is colored with the editor's own border color so it matches the
 *     violet thinking border.
 *   - Toggling Ultracode off (/ultracode-mode off) removes the label and restores
 *     a plain border.
 *   - A scrolled prompt (top border showing "↑ N more") is left untouched so the
 *     indicator never clobbers the scroll hint.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildExtension as sharedBuildExtension,
	createChecker,
	sdkStub,
} from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildExtension() {
	return await sharedBuildExtension({
		name: "pi-dwf-ultracode-border",
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "index.ts"),
		outName: "dynamic-workflows.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "full" }),
		},
		npx: "--yes",
	});
}

let instance = 0;
async function freshExtension(url) {
	const mod = await import(`${url}?i=${instance++}`);
	return mod.default;
}

function makePi() {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const activeTools = [];
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
		getActiveTools: () => activeTools,
		getAllTools: () => [...tools.values()],
		setActiveTools: (next) => {
			activeTools.splice(0, activeTools.length, ...next);
		},
		exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
	};
	return { pi, tools, commands, handlers };
}

// Real ANSI violet wrapper so the extension's ANSI-aware border detection behaves
// exactly as in the live TUI, and we can assert the label inherits the border color.
function violet(str) {
	return `\x1b[35m${str}\x1b[0m`;
}

function makeBorderBaseEditor({ scrolled = false } = {}) {
	return {
		actionHandlers: new Map(),
		focused: false,
		borderColor: violet,
		getText: () => "",
		setText: () => {},
		handleInput: () => {},
		render: (width) => {
			const top = scrolled
				? violet("─── ↑ 3 more ") + violet("─".repeat(Math.max(0, width - 13)))
				: violet("─".repeat(width));
			return [top, "prompt", violet("─".repeat(width))];
		},
		invalidate: () => {},
		getCursor: () => ({ line: 0, col: 0 }),
		isShowingAutocomplete: () => false,
		addToHistory: () => {},
		insertTextAtCursor: () => {},
		getExpandedText: () => "",
		setAutocompleteProvider: () => {},
		setPaddingX: () => {},
		setAutocompleteMaxVisible: () => {},
	};
}

function makeCtx(cwd, baseFactory) {
	let editorFactory;
	const theme = {
		fg: (_color, value) => value,
		bg: (_color, value) => value,
		bold: (value) => value,
	};
	const ctx = {
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
			editor: async (_title, initial = "") => initial,
			getEditorComponent: () => baseFactory,
			setEditorComponent: (factory) => {
				editorFactory = factory;
			},
			custom: async () => null,
		},
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [],
			getSessionId: () => "test-session-id",
			getSessionFile: () => path.join(cwd, ".pi", "sessions", "test-session.jsonl"),
			getSessionName: () => "Test session",
		},
	};
	return { ctx, getEditorFactory: () => editorFactory };
}

async function makeProject() {
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-ultracode-border-project-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	return project;
}

async function installEditor(url, baseEditor) {
	const project = await makeProject();
	const ext = await freshExtension(url);
	const { pi, handlers, commands } = makePi();
	ext(pi);
	const state = makeCtx(project, () => baseEditor);
	for (const handler of handlers.get("session_start") ?? []) {
		await handler({ reason: "startup" }, state.ctx);
	}
	const editorFactory = state.getEditorFactory();
	if (typeof editorFactory !== "function")
		throw new Error("session_start did not install an editor factory");
	const wrapped = editorFactory(
		{ requestRender: () => {}, terminal: { rows: 30, columns: 100 } },
		state.ctx.ui.theme,
		{},
	);
	return { ...state, commands, wrapped };
}

async function scenarioShowsLabelWhenUltracodeOn(url) {
	const { wrapped } = await installEditor(url, makeBorderBaseEditor());
	const top = wrapped.render(80)[0];
	check("top border shows ultracode auto when on", top.includes("ultracode auto"), top);
	check("top border is still a border (keeps ─)", top.includes("─"), top);
	check(
		"ultracode label is colored with the editor border color",
		top.includes(violet(" ultracode auto ")),
		top,
	);
}

async function scenarioHidesLabelWhenUltracodeOff(url) {
	const { wrapped, commands } = await installEditor(url, makeBorderBaseEditor());
	const beforeCtx = makeCtx("/tmp/x", () => makeBorderBaseEditor()).ctx;
	await commands.get("ultracode-mode").handler("off", beforeCtx);
	const top = wrapped.render(80)[0];
	check("top border hides label when ultracode off", !top.includes("ultracode auto"), top);
	check("top border restored to plain border when off", top === violet("─".repeat(80)), top);
}

async function scenarioLeavesScrollIndicatorUntouched(url) {
	const { wrapped } = await installEditor(url, makeBorderBaseEditor({ scrolled: true }));
	const top = wrapped.render(80)[0];
	check("scrolled top border keeps the scroll hint", top.includes("↑ 3 more"), top);
	check(
		"scrolled top border is not decorated with the label",
		!top.includes("ultracode auto"),
		top,
	);
}

async function main() {
	const { url } = await buildExtension();
	await scenarioShowsLabelWhenUltracodeOn(url);
	await scenarioHidesLabelWhenUltracodeOff(url);
	await scenarioLeavesScrollIndicatorUntouched(url);

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
