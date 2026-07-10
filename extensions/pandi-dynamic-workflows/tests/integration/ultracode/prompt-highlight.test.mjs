#!/usr/bin/env node
/**
 * Behavioral test for the animated multicolor "ultracode" effect painted over the word
 * the user types in the prompt (not the border label).
 *
 * Observable contract:
 *   - The typed keyword "ultracode" is recolored with per-character truecolor escapes,
 *     while the rest of the prompt text is left untouched (still contiguous/plain).
 *   - The effect is case-insensitive and matches multiple occurrences.
 *   - The visible text and width are unchanged (only zero-width color escapes are added).
 *   - The zero-width hardware-cursor marker embedded inside the word is preserved in place.
 *   - Advancing the animation phase changes the rendered colors.
 *   - Prompt text without the keyword is rendered byte-for-byte unchanged.
 *   - The top border line (index 0) is never recolored by the keyword pass.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../../shared/test/harness.mjs";

// Advertise truecolor so color detection picks the rainbow path deterministically.
process.env.COLORTERM = "truecolor";

const CURSOR_MARKER = "\x1b_pi:c\x07";
const stripColor = (value) => value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const stripAll = (value) => stripColor(value).replace(/\x1b_[^\x07]*\x07/g, "");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildExtension() {
	return await sharedBuildExtension({
		name: "pi-dwf-ultracode-highlight",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "index.ts"),
		outName: "dynamic-workflows.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "full" }),
		},
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

function violet(str) {
	return `\x1b[35m${str}\x1b[0m`;
}

// A base editor whose content line carries the given prompt text, so the wrapper's
// keyword pass has something to recolor. Line 0 / last line are plain borders.
function makeContentBaseEditor(promptLine) {
	return {
		actionHandlers: new Map(),
		focused: true,
		borderColor: violet,
		getText: () => stripAll(promptLine).replace(/^>\s?/, ""),
		setText: () => {},
		handleInput: () => {},
		render: (width) => [violet("─".repeat(width)), promptLine, violet("─".repeat(width))],
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

// A base editor that renders like the real one when the slash-command menu is open:
// [top border, typed input, bottom border, ...autocomplete suggestions]. The suggestion
// lines deliberately contain the keywords so we can prove they are NOT recolored.
function makeAutocompleteBaseEditor(promptLine, suggestionLines) {
	const base = makeContentBaseEditor(promptLine);
	base.isShowingAutocomplete = () => true;
	base.render = (width) => [violet("─".repeat(width)), promptLine, violet("─".repeat(width)), ...suggestionLines];
	return base;
}

function makeCtx(cwd, baseFactory) {
	let editorFactory;
	const theme = { fg: (_c, v) => v, bg: (_c, v) => v, bold: (v) => v };
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
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-ultracode-highlight-project-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	return project;
}

async function installEditor(url, baseEditor) {
	const project = await makeProject();
	const ext = await freshExtension(url);
	const { pi, handlers } = makePi();
	ext(pi);
	const state = makeCtx(project, () => baseEditor);
	for (const handler of handlers.get("session_start") ?? []) {
		await handler({ reason: "startup" }, state.ctx);
	}
	const editorFactory = state.getEditorFactory();
	if (typeof editorFactory !== "function") throw new Error("session_start did not install an editor factory");
	const wrapped = editorFactory(
		{ requestRender: () => {}, terminal: { rows: 30, columns: 100 } },
		state.ctx.ui.theme,
		{},
	);
	return { wrapped };
}

async function scenarioColorsTypedKeyword(url) {
	const { wrapped } = await installEditor(url, makeContentBaseEditor("> ultracode do X"));
	const line = wrapped.render(80)[1];
	check("typed ultracode is recolored (truecolor escapes present)", line.includes("\x1b[38;2;"), line);
	check("visible text is preserved", stripAll(line).includes("ultracode do X"), stripAll(line));
	check("visible width is unchanged", stripAll(line).length === "> ultracode do X".length, stripAll(line));
	check("non-keyword text stays plain/contiguous", line.includes("do X"), line);
	check("keyword is no longer plain/contiguous (it was colored)", !line.includes("ultracode"), line);
}

async function scenarioCaseInsensitiveAndMultiple(url) {
	const { wrapped } = await installEditor(url, makeContentBaseEditor("> ULTRAcode then ultracode"));
	const line = wrapped.render(80)[1];
	// Behavior, not technique: both spellings (mixed-case + lowercase) get recolored so neither stays
	// plain/contiguous, some color escape is present, and the visible text is preserved — WITHOUT pinning
	// the per-character truecolor escape count (a refactor to 256-color or coalesced runs stays valid).
	check("some color escape is emitted", /\x1b\[/.test(line), line);
	check("case-insensitive match colored the mixed-case keyword", !line.includes("ULTRAcode"), line);
	check("match colored the lowercase keyword too (twice)", !line.includes("ultracode"), line);
	check(
		"visible text preserved across both matches",
		stripAll(line).includes("ULTRAcode then ultracode"),
		stripAll(line),
	);
	check("plain words between matches remain", line.includes(" then "), line);
}

async function scenarioPreservesCursorMarker(url) {
	const { wrapped } = await installEditor(url, makeContentBaseEditor(`> ultr${CURSOR_MARKER}acode do X`));
	const line = wrapped.render(80)[1];
	check("cursor marker is preserved in place", line.includes(CURSOR_MARKER), JSON.stringify(line));
	check("keyword still detected across the marker", stripAll(line).includes("ultracode do X"), stripAll(line));
}

async function scenarioAnimatesOverTime(url) {
	const { wrapped } = await installEditor(url, makeContentBaseEditor("> ultracode do X"));
	const frame0 = wrapped.render(80)[1];
	for (let i = 0; i < 5; i++) wrapped.advanceRainbow();
	const frame1 = wrapped.render(80)[1];
	check("advancing the phase changes the colors", frame0 !== frame1, `${frame0} :: ${frame1}`);
	check("animated frame keeps the visible word", stripAll(frame1).includes("ultracode"), frame1);
}

async function scenarioColorsWorkflowKeyword(url) {
	const { wrapped } = await installEditor(url, makeContentBaseEditor("> run the workflow now"));
	const line = wrapped.render(80)[1];
	check("typed workflow is recolored (truecolor escapes present)", line.includes("\x1b[38;2;"), line);
	check("workflow visible text is preserved", stripAll(line).includes("run the workflow now"), stripAll(line));
	check("workflow keyword is no longer plain/contiguous", !line.includes("workflow"), line);
	check("non-keyword words around workflow stay plain", line.includes("run the ") && line.includes(" now"), line);
}

async function scenarioColorsWorkflowsKeyword(url) {
	const { wrapped } = await installEditor(url, makeContentBaseEditor("> run the workflows now"));
	const line = wrapped.render(80)[1];
	check("typed workflows is recolored (truecolor escapes present)", line.includes("\x1b[38;2;"), line);
	check("workflows visible text is preserved", stripAll(line).includes("run the workflows now"), stripAll(line));
	check("workflows keyword is no longer plain/contiguous", !line.includes("workflows"), line);
	check("non-keyword words around workflows stay plain", line.includes("run the ") && line.includes(" now"), line);
}

async function scenarioColorsBothKeywordsInOneLine(url) {
	const { wrapped } = await installEditor(url, makeContentBaseEditor("> ultracode build a workflow"));
	const line = wrapped.render(80)[1];
	check(
		"both ultracode and workflow recolored in one line",
		stripAll(line).includes("ultracode build a workflow"),
		line,
	);
	check("neither keyword remains plain/contiguous", !line.includes("ultracode") && !line.includes("workflow"), line);
	check("the word between keywords stays plain", line.includes(" build a "), line);
}

async function scenarioLeavesKeywordlessTextUntouched(url) {
	const { wrapped } = await installEditor(url, makeContentBaseEditor("> hello world"));
	const line = wrapped.render(80)[1];
	check("prompt without the keyword is unchanged", line === "> hello world", JSON.stringify(line));
}

// The keyword only colorizes as a standalone token: bounded left by start/space/slash and right
// by end/space. A keyword glued to a larger word ("workflowing", "myultracode") must NOT recolor.
async function scenarioDoesNotColorSubstringInsideLargerWord(url) {
	const { wrapped } = await installEditor(url, makeContentBaseEditor("> run the workflowing now"));
	const line = wrapped.render(80)[1];
	check("keyword as a substring of a larger word is NOT recolored", !line.includes("\x1b[38;2;"), line);
	check("text with an embedded keyword is byte-unchanged", line === "> run the workflowing now", JSON.stringify(line));
}

async function scenarioDoesNotColorKeywordGluedToPrecedingWord(url) {
	const { wrapped } = await installEditor(url, makeContentBaseEditor("> myultracode rocks"));
	const line = wrapped.render(80)[1];
	check("keyword glued to a preceding word is NOT recolored", !line.includes("\x1b[38;2;"), line);
	check("glued-keyword text is byte-unchanged", line === "> myultracode rocks", JSON.stringify(line));
}

async function scenarioColorsSlashPrefixedKeyword(url) {
	const { wrapped } = await installEditor(url, makeContentBaseEditor("> /ultracode do X"));
	const line = wrapped.render(80)[1];
	check("slash-prefixed keyword is recolored", line.includes("\x1b[38;2;"), line);
	check("slash + visible text preserved", stripAll(line).includes("/ultracode do X"), stripAll(line));
}

async function scenarioColorsKeywordAtEndOfLine(url) {
	// Option A: end-of-text is a valid right boundary, so a just-typed word colorizes immediately.
	const { wrapped } = await installEditor(url, makeContentBaseEditor("> /ultracode"));
	const line = wrapped.render(80)[1];
	check("keyword at end of line (no trailing space) is recolored", line.includes("\x1b[38;2;"), line);
}

async function scenarioNeverColorsAutocompleteDropdown(url) {
	const suggestions = ["ultracode-mode   toggle ultracode workflow routing", "skill:ultracode  run a workflow"];
	const { wrapped } = await installEditor(url, makeAutocompleteBaseEditor("> ultracode", suggestions));
	const rendered = wrapped.render(80);
	const input = rendered[1];
	const dropdown = rendered.slice(3).join("\n");
	check("typed input line is still recolored", input.includes("\x1b[38;2;"), input);
	check("autocomplete dropdown is NOT recolored", !dropdown.includes("\x1b[38;2;"), dropdown);
	check(
		"dropdown keeps its plain keyword text",
		dropdown.includes("ultracode") && dropdown.includes("workflow"),
		dropdown,
	);
}

async function scenarioNeverColorsTopBorder(url) {
	const { wrapped } = await installEditor(url, makeContentBaseEditor("> ultracode do X"));
	const top = wrapped.render(80)[0];
	check("top border line is not recolored by the keyword pass", !top.includes("\x1b[38;2;"), top);
}

async function main() {
	const { url } = await buildExtension();
	await scenarioColorsTypedKeyword(url);
	await scenarioColorsWorkflowKeyword(url);
	await scenarioColorsWorkflowsKeyword(url);
	await scenarioColorsBothKeywordsInOneLine(url);
	await scenarioCaseInsensitiveAndMultiple(url);
	await scenarioPreservesCursorMarker(url);
	await scenarioAnimatesOverTime(url);
	await scenarioLeavesKeywordlessTextUntouched(url);
	await scenarioDoesNotColorSubstringInsideLargerWord(url);
	await scenarioDoesNotColorKeywordGluedToPrecedingWord(url);
	await scenarioColorsSlashPrefixedKeyword(url);
	await scenarioColorsKeywordAtEndOfLine(url);
	await scenarioNeverColorsAutocompleteDropdown(url);
	await scenarioNeverColorsTopBorder(url);

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
