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

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createChecker } from "../../../../scripts/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildExtension() {
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-ultracode-border-"));

	const typeboxStub = path.join(outDir, "stub-typebox.mjs");
	await fs.writeFile(
		typeboxStub,
		"const id = (x) => x ?? {};\nexport const Type = { Object: id, Number: id, String: id, Boolean: id, Array: id, Optional: id, Union: id, Literal: id, Any: id, Integer: id };\nexport default { Type };\n",
	);
	const typeboxValueStub = path.join(outDir, "stub-typebox-value.mjs");
	await fs.writeFile(typeboxValueStub, "export const Value = { Check: () => true, Errors: function* () {} };\nexport default { Value };\n");
	const sdkStub = path.join(outDir, "stub-sdk.mjs");
	await fs.writeFile(
		sdkStub,
		`export const CONFIG_DIR_NAME = ".pi";\nexport function getAgentDir() { return ${JSON.stringify(path.join(outDir, "agentdir"))}; }\nexport class CustomEditor { constructor() {} getText() { return ""; } setText() {} handleInput() {} render() { return []; } invalidate() {} }\n`,
	);
	const aiStub = path.join(outDir, "stub-ai.mjs");
	await fs.writeFile(aiStub, "export function StringEnum(values, opts = {}) { return { ...opts, enum: values }; }\n");
	const tuiStub = path.join(outDir, "stub-tui.mjs");
	await fs.writeFile(
		tuiStub,
		`export class Image { constructor() {} input() {} render() { return []; } }\nexport const Key = { escape: "escape", enter: "enter", up: "up", down: "down", pageUp: "pageUp", pageDown: "pageDown", home: "home", end: "end", delete: "delete", backspace: "backspace", tab: "tab", left: "left", right: "right", ctrlAlt: (key) => "ctrlAlt:" + key };\nexport function getCapabilities() { return { images: false }; }\nexport function matchesKey(data, key) { return data === key; }\nexport function truncateToWidth(value, width, suffix = "") { const s = String(value); return s.length > width ? s.slice(0, Math.max(0, width - suffix.length)) + suffix : s; }\nexport function visibleWidth(value) { return String(value).length; }\n`,
	);

	const src = path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "index.ts");
	if (!existsSync(src)) throw new Error(`missing source: ${src}`);
	const out = path.join(outDir, "dynamic-workflows.mjs");
	const r = spawnSync(
		"npx",
		[
			"--yes",
			"esbuild",
			src,
			"--bundle",
			"--platform=node",
			"--format=esm",
			`--alias:typebox=${typeboxStub}`,
			`--alias:typebox/value=${typeboxValueStub}`,
			`--alias:@earendil-works/pi-coding-agent=${sdkStub}`,
			`--alias:@earendil-works/pi-ai=${aiStub}`,
			`--alias:@earendil-works/pi-tui=${tuiStub}`,
			`--outfile=${out}`,
		],
		{ cwd: REPO_ROOT, encoding: "utf8" },
	);
	if (r.status !== 0) throw new Error(`esbuild failed: ${r.stderr || r.stdout}`);
	return { outDir, url: pathToFileURL(out).href };
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
	if (typeof editorFactory !== "function") throw new Error("session_start did not install an editor factory");
	const wrapped = editorFactory({ requestRender: () => {}, terminal: { rows: 30, columns: 100 } }, state.ctx.ui.theme, {});
	return { ...state, commands, wrapped };
}

async function scenarioShowsLabelWhenUltracodeOn(url) {
	const { wrapped } = await installEditor(url, makeBorderBaseEditor());
	const top = wrapped.render(80)[0];
	check("top border shows ultracode auto when on", top.includes("ultracode auto"), top);
	check("top border is still a border (keeps ─)", top.includes("─"), top);
	check("ultracode label is colored with the editor border color", top.includes(violet(" ultracode auto ")), top);
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
	check("scrolled top border is not decorated with the label", !top.includes("ultracode auto"), top);
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
