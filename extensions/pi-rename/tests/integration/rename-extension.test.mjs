#!/usr/bin/env node
/**
 * Durable behavioral integration test for extensions/pi-rename/index.ts and its pure
 * helpers (derive-name.ts, border-label.ts).
 *
 * Pins the public /rename contract:
 * - every applied name is a slug (lowercase, hyphen-separated, diacritics stripped),
 *   capped at MAX_NAME_WORDS (4) words, and never ending on a dangling connector word
 *   (trailing articles/prepositions/conjunctions are trimmed so it reads as a name)
 * - /rename <name> slugifies and sets the session name
 * - /rename with no arg, headless, derives a slug from the most recent user message
 * - /rename with no arg never opens a dialog: it invents a slug from history and applies
 *   it directly, whether or not UI is available
 * - empty/whitespace history falls back to a default name
 * - setSessionName failures are reported, not thrown
 * - the current name is shown as a label embedded in the editor's top border, composing
 *   with an existing right-aligned label (e.g. "ultracode auto") and leaving scroll
 *   hints untouched; the outer editor layer delegates all other behavior and does not
 *   stack across reloads
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, loadModule, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildRename() {
	return await buildExtension({
		name: "pi-rename-integration",
		src: path.join(REPO_ROOT, "extensions", "pi-rename", "index.ts"),
		outName: "rename.mjs",
		stubs: { sdk: (dir) => sdkStub(dir, { customEditor: "render" }) },
		npx: "--yes",
	});
}

async function buildPureModule(file, outName, name) {
	return await buildExtension({
		name,
		src: path.join(REPO_ROOT, "extensions", "pi-rename", file),
		outName,
		npx: "--yes",
	});
}

function userEntry(content) {
	return { type: "message", message: { role: "user", content } };
}

function assistantEntry(text) {
	return { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function stripAnsi(value) {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function violet(value) {
	return `\x1b[35m${value}\x1b[0m`;
}

function makePi({ throwOnSet = false, initialName } = {}) {
	let sessionName = initialName;
	const commands = new Map();
	const handlers = new Map();
	const pi = {
		registerCommand: (name, opts) => commands.set(name, opts),
		on: (event, handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		setSessionName: (name) => {
			if (throwOnSet) throw new Error("boom");
			sessionName = name;
		},
		getSessionName: () => sessionName,
	};
	return {
		pi,
		commands,
		handlers,
		get sessionName() {
			return sessionName;
		},
	};
}

function makeCtx({ hasUI = false, entries = [], inputResult, mode = "tui" } = {}) {
	const notes = [];
	const inputCalls = [];
	const ctx = {
		mode,
		hasUI,
		ui: {
			notify: (msg, type) => notes.push({ msg, type }),
			input: async (title, placeholder) => {
				inputCalls.push({ title, placeholder });
				return inputResult;
			},
		},
		sessionManager: { getEntries: () => entries },
	};
	ctx._notes = notes;
	ctx._inputCalls = inputCalls;
	return ctx;
}

// A ctx that supports the editor-component install path (mirrors the host wiring).
function makeEditorCtx(baseFactory) {
	let currentFactory = baseFactory;
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			notify: () => {},
			input: async () => undefined,
			getEditorComponent: () => currentFactory,
			setEditorComponent: (factory) => {
				currentFactory = factory;
			},
		},
		sessionManager: { getEntries: () => [] },
	};
	return { ctx, getFactory: () => currentFactory };
}

// Minimal base editor producing a plain (or pre-decorated) violet top border.
function makeFakeEditor({ topLine } = {}) {
	const calls = { handleInput: [], invalidate: 0 };
	return {
		calls,
		borderColor: violet,
		focused: false,
		getText: () => "base-text",
		setText: () => {},
		handleInput: (data) => calls.handleInput.push(data),
		invalidate: () => {
			calls.invalidate += 1;
		},
		render: (width) => [topLine ? topLine(width) : violet("─".repeat(width)), "prompt", violet("─".repeat(width))],
	};
}

function borderWithLabel(label, width, color = violet) {
	const text = ` ${label} `;
	const right = 2;
	const left = width - text.length - right;
	return color("─".repeat(left) + text + "─".repeat(right));
}

async function fire(handlers, event, payload, ctx) {
	for (const handler of handlers.get(event) || []) await handler(payload, ctx);
}

async function scenarioSlugifyUnit(url) {
	const { slugify, deriveSessionName, DEFAULT_SESSION_NAME, MAX_NAME_WORDS } = await loadModule(url);

	check("MAX_NAME_WORDS is 4", MAX_NAME_WORDS === 4);
	check("slugify trims", slugify("  hi  ") === "hi");
	check("slugify lowercases and hyphenates words", slugify("Refactor Auth Module") === "refactor-auth-module");
	check("slugify drops punctuation", slugify('"Hello World!"') === "hello-world");
	check("slugify collapses non-alnum runs", slugify("a   b\tc--d") === "a-b-c-d");
	check("slugify strips diacritics", slugify("Café déjà vu") === "cafe-deja-vu");
	check("slugify empty stays empty", slugify("   ") === "");
	check("slugify non-ascii-only yields empty", slugify("日本語") === "");
	check("slugify is idempotent on a slug", slugify("refactor-auth") === "refactor-auth");
	check("slugify default caps at 4 words", slugify("alpha beta gamma delta epsilon") === "alpha-beta-gamma-delta");
	check(
		"slugify respects explicit maxWords",
		slugify("alpha beta gamma delta", { maxWords: 2, maxChars: 100 }) === "alpha-beta",
	);
	check(
		"slugify truncates on a word boundary within maxChars",
		(() => {
			const out = slugify("one two three four", { maxChars: 7, maxWords: 8 });
			return out === "one-two" && out.length <= 7;
		})(),
	);
	check(
		"slugify hard-truncates a single oversized word",
		slugify("supercalifragilistic", { maxChars: 5 }) === "super",
	);

	// A name should never end on a dangling connector (article/preposition/conjunction).
	check(
		"slugify drops a trailing connector word (es)",
		slugify("arreglar el bug de") === "arreglar-el-bug",
		slugify("arreglar el bug de"),
	);
	check(
		"slugify drops a trailing connector word (en)",
		slugify("cache invalidation strategy for", { maxWords: 8, maxChars: 100 }) === "cache-invalidation-strategy",
		slugify("cache invalidation strategy for", { maxWords: 8, maxChars: 100 }),
	);
	check(
		"slugify drops multiple trailing connectors",
		slugify("save the cache for the", { maxWords: 8, maxChars: 100 }) === "save-the-cache",
		slugify("save the cache for the", { maxWords: 8, maxChars: 100 }),
	);
	check(
		"slugify keeps a meaningful trailing word",
		slugify("refactor the auth module") === "refactor-the-auth-module",
		slugify("refactor the auth module"),
	);
	check(
		"slugify does not empty an all-connector slug",
		slugify("the of and", { maxWords: 8, maxChars: 100 }) === "the",
		slugify("the of and", { maxWords: 8, maxChars: 100 }),
	);
	check(
		"slugify trailing-connector trim respects the word cap first (stays a short name)",
		slugify("arreglar el bug de login cuando el usuario") === "arreglar-el-bug",
		slugify("arreglar el bug de login cuando el usuario"),
	);

	check(
		"deriveSessionName slugs the MOST RECENT user message (tracks current work)",
		deriveSessionName([assistantEntry("ignored"), userEntry("Fix the login bug"), userEntry("now do the cache")]) ===
			"now-do-the-cache",
	);
	check(
		"deriveSessionName walks back past a trailing /rename invocation and empty turns",
		deriveSessionName([
			userEntry("Initial task"),
			userEntry("Harden the loop gate"),
			userEntry("/rename"),
			userEntry("   "),
		]) === "harden-the-loop-gate",
		deriveSessionName([
			userEntry("Initial task"),
			userEntry("Harden the loop gate"),
			userEntry("/rename"),
			userEntry("   "),
		]),
	);
	check(
		"deriveSessionName joins text blocks and ignores images",
		deriveSessionName([
			userEntry([
				{ type: "image", data: "x", mimeType: "image/png" },
				{ type: "text", text: "Add Dark Mode" },
			]),
		]) === "add-dark-mode",
	);
	check(
		"deriveSessionName strips a leading slash-command token",
		deriveSessionName([userEntry("/explain the cache layer")]) === "the-cache-layer",
	);
	check(
		"deriveSessionName caps a long message at 4 words",
		deriveSessionName([userEntry("Investigate the flaky CI pipeline failures")]) === "investigate-the-flaky-ci",
	);
	check(
		"deriveSessionName does not leave a dangling connector after the word cap",
		deriveSessionName([userEntry("arreglar el bug de login cuando el usuario no tiene")]) === "arreglar-el-bug",
		deriveSessionName([userEntry("arreglar el bug de login cuando el usuario no tiene")]),
	);
	check(
		"deriveSessionName skips empty user messages (most recent non-empty wins)",
		deriveSessionName([userEntry("Real content here now"), userEntry("   ")]) === "real-content-here-now",
	);
	check("deriveSessionName falls back to default on empty history", deriveSessionName([]) === DEFAULT_SESSION_NAME);
	check("deriveSessionName tolerates non-array input", deriveSessionName(null) === DEFAULT_SESSION_NAME);
}

async function scenarioBorderLabelUnit(url) {
	const { composeTopBorder } = await loadModule(url);

	const plain80 = "─".repeat(80);
	const named = composeTopBorder(plain80, 80, "my-task");
	check("composeTopBorder adds the label on a plain border", named?.includes("my-task") === true, named);
	check("composeTopBorder keeps the border glyphs", named?.includes("─") === true, named);
	check("composeTopBorder keeps the line width", named?.length === 80, String(named?.length));
	check("composeTopBorder does not add a cardinal", named?.includes("⌗") === false, named);

	const pillNamed = composeTopBorder(plain80, 80, "my-task", { color: (s) => s, labelColor: (s) => `[${s}]` });
	check(
		"composeTopBorder styles the name with labelColor (pill)",
		pillNamed?.includes("[ my-task ]") === true,
		pillNamed,
	);

	const withUltra = composeTopBorder(
		borderWithLabel("ultracode auto", 80, (s) => s),
		80,
		"my-task",
		{
			color: (s) => s,
		},
	);
	check(
		"composeTopBorder composes with an existing right-aligned label",
		withUltra?.includes("my-task") === true && withUltra?.includes("ultracode auto") === true,
		withUltra,
	);
	check(
		"composeTopBorder puts the existing label first and the name last (inverted order)",
		withUltra != null && withUltra.indexOf("ultracode auto") < withUltra.indexOf("my-task"),
		withUltra,
	);

	const scrolled = `─── ↑ 3 more ${"─".repeat(80 - 13)}`;
	check(
		"composeTopBorder leaves a scroll hint untouched (returns null)",
		composeTopBorder(scrolled, 80, "x") === null,
	);
	check("composeTopBorder bails on a non-border line", composeTopBorder("hello world", 80, "x") === null);
	check("composeTopBorder bails when there is no room", composeTopBorder("─".repeat(6), 6, "a long label") === null);
	check("composeTopBorder bails with an empty label", composeTopBorder(plain80, 80, "") === null);
}

async function scenarioExplicitName(url) {
	const renameExtension = await loadDefault(url);
	const harness = makePi();
	renameExtension(harness.pi);
	const command = harness.commands.get("rename");
	check("/rename command registered", !!command);
	check("/rename has a description", typeof command.description === "string" && command.description.length > 0);

	const ctx = makeCtx({ hasUI: true });
	await command.handler("Refactor Auth", ctx);
	check("/rename <name> sets a slug session name", harness.sessionName === "refactor-auth", harness.sessionName);
	check(
		"/rename <name> notifies success with the slug",
		ctx._notes.some((n) => n.type === "info" && /renamed to "refactor-auth"/.test(n.msg)),
		JSON.stringify(ctx._notes),
	);
	check("/rename <name> does not open the input dialog", ctx._inputCalls.length === 0);

	await command.handler('  "  Hello   World!  "  ', ctx);
	check("/rename slugifies quotes and punctuation", harness.sessionName === "hello-world", harness.sessionName);

	await command.handler("one two three four five", ctx);
	check("/rename caps an explicit name at 4 words", harness.sessionName === "one-two-three-four", harness.sessionName);
}

async function scenarioNoArgHeadless(url) {
	const renameExtension = await loadDefault(url);
	const harness = makePi();
	renameExtension(harness.pi);
	const command = harness.commands.get("rename");

	const ctx = makeCtx({
		hasUI: false,
		entries: [userEntry("Set up the project"), userEntry("Investigate flaky CI pipeline")],
	});
	await command.handler("", ctx);
	check(
		"/rename no-arg headless derives a slug from the most recent user message",
		harness.sessionName === "investigate-flaky-ci-pipeline",
		harness.sessionName,
	);
	check("/rename no-arg headless does not open input dialog", ctx._inputCalls.length === 0);

	// whitespace-only argument is treated as no-arg.
	const harness2 = makePi();
	renameExtension(harness2.pi);
	const command2 = harness2.commands.get("rename");
	const ctx2 = makeCtx({ hasUI: false, entries: [userEntry("Spaces only arg path")] });
	await command2.handler("    ", ctx2);
	check(
		"/rename whitespace-only arg falls to the no-arg derive path",
		harness2.sessionName === "spaces-only-arg-path",
		harness2.sessionName,
	);
}

async function scenarioNoArgUI(url) {
	const renameExtension = await loadDefault(url);
	const command = (h) => h.commands.get("rename");
	const entries = [userEntry("Build the rename extension")];

	// Even with UI available, no-arg invents the name and NEVER opens an input dialog.
	const h1 = makePi();
	renameExtension(h1.pi);
	const ctx1 = makeCtx({ hasUI: true, entries, inputResult: "Should Be Ignored" });
	await command(h1).handler("", ctx1);
	check("/rename no-arg with UI invents the name", h1.sessionName === "build-the-rename-extension", h1.sessionName);
	check(
		"/rename no-arg with UI does NOT open an input dialog",
		ctx1._inputCalls.length === 0,
		JSON.stringify(ctx1._inputCalls),
	);
}

async function scenarioBorderEditor(url) {
	const renameExtension = await loadDefault(url);

	// Name shown in the top border once installed.
	const h1 = makePi({ initialName: "my-task" });
	renameExtension(h1.pi);
	const fake1 = makeFakeEditor();
	const e1 = makeEditorCtx(() => fake1);
	await fire(h1.handlers, "session_start", {}, e1.ctx);
	const factory1 = e1.getFactory();
	check("session_start installs an editor factory", typeof factory1 === "function");
	const wrapped1 = factory1({ requestRender() {} }, {}, {});
	const raw1 = wrapped1.render(80)[0];
	const top1 = stripAnsi(raw1);
	check("top border shows the session name", top1.includes("my-task"), top1);
	check("top border keeps border glyphs", top1.includes("─"), top1);
	check("top border drops the cardinal", !top1.includes("⌗"), top1);
	check("name renders as an inverted pill (reverse video)", raw1.includes("\x1b[7m"), JSON.stringify(raw1));
	check("wrapped editor carries the reuse marker", wrapped1.__piRenameNameBorderEditor === true);

	// Delegates non-render behavior to the base editor.
	check("wrapped editor delegates getText", wrapped1.getText() === "base-text");
	wrapped1.handleInput("x");
	check("wrapped editor delegates handleInput", fake1.calls.handleInput.includes("x"));

	// Composes with an existing right-aligned label (ultracode auto).
	const h2 = makePi({ initialName: "my-task" });
	renameExtension(h2.pi);
	const fake2 = makeFakeEditor({ topLine: (w) => borderWithLabel("ultracode auto", w) });
	const e2 = makeEditorCtx(() => fake2);
	await fire(h2.handlers, "session_start", {}, e2.ctx);
	const top2 = stripAnsi(
		e2
			.getFactory()({ requestRender() {} }, {}, {})
			.render(80)[0],
	);
	check(
		"border composes name with ultracode label",
		top2.includes("my-task") && top2.indexOf("ultracode auto") < top2.indexOf("my-task"),
		top2,
	);

	// Leaves a scroll hint untouched.
	const h3 = makePi({ initialName: "my-task" });
	renameExtension(h3.pi);
	const fake3 = makeFakeEditor({ topLine: (w) => violet(`─── ↑ 3 more ${"─".repeat(w - 13)}`) });
	const e3 = makeEditorCtx(() => fake3);
	await fire(h3.handlers, "session_start", {}, e3.ctx);
	const top3 = stripAnsi(
		e3
			.getFactory()({ requestRender() {} }, {}, {})
			.render(80)[0],
	);
	check("scroll hint left untouched (no name injected)", top3.includes("↑ 3 more") && !top3.includes("my-task"), top3);

	// Unnamed session: border passes through unchanged.
	const h4 = makePi();
	renameExtension(h4.pi);
	const fake4 = makeFakeEditor();
	const e4 = makeEditorCtx(() => fake4);
	await fire(h4.handlers, "session_start", {}, e4.ctx);
	const top4 = stripAnsi(
		e4
			.getFactory()({ requestRender() {} }, {}, {})
			.render(80)[0],
	);
	check("unnamed session leaves the border plain", !top4.includes("my-task") && /^─+$/.test(top4), top4);

	// Reloading session_start must not stack another layer.
	const h5 = makePi({ initialName: "my-task" });
	renameExtension(h5.pi);
	const fake5 = makeFakeEditor();
	const e5 = makeEditorCtx(() => fake5);
	await fire(h5.handlers, "session_start", {}, e5.ctx);
	await fire(h5.handlers, "session_start", {}, e5.ctx);
	const top5 = stripAnsi(
		e5
			.getFactory()({ requestRender() {} }, {}, {})
			.render(80)[0],
	);
	check("reload does not double-wrap the label", (top5.match(/my-task/g) || []).length === 1, top5);
}

async function scenarioFallbacksAndErrors(url) {
	const renameExtension = await loadDefault(url);
	const command = (h) => h.commands.get("rename");

	// Empty history headless -> default name.
	const h1 = makePi();
	renameExtension(h1.pi);
	const ctx1 = makeCtx({ hasUI: false, entries: [] });
	await command(h1).handler("", ctx1);
	check("/rename empty history falls back to default", h1.sessionName === "session", h1.sessionName);

	// setSessionName throws -> reported as error, no crash.
	const h2 = makePi({ throwOnSet: true });
	renameExtension(h2.pi);
	const ctx2 = makeCtx({ hasUI: true });
	let threw = false;
	try {
		await command(h2).handler("anything", ctx2);
	} catch {
		threw = true;
	}
	check("/rename does not crash when setSessionName throws", !threw);
	check(
		"/rename reports a setSessionName failure",
		ctx2._notes.some((n) => n.type === "error" && /failed to rename/i.test(n.msg)),
		JSON.stringify(ctx2._notes),
	);
}

async function main() {
	const derive = await buildPureModule("derive-name.ts", "derive.mjs", "pi-rename-derive");
	try {
		await scenarioSlugifyUnit(derive.url);
	} finally {
		await fs.rm(derive.outDir, { recursive: true, force: true });
	}

	const border = await buildPureModule("border-label.ts", "border.mjs", "pi-rename-border");
	try {
		await scenarioBorderLabelUnit(border.url);
	} finally {
		await fs.rm(border.outDir, { recursive: true, force: true });
	}

	const ext = await buildRename();
	try {
		await scenarioExplicitName(ext.url);
		await scenarioNoArgHeadless(ext.url);
		await scenarioNoArgUI(ext.url);
		await scenarioBorderEditor(ext.url);
		await scenarioFallbacksAndErrors(ext.url);
	} finally {
		await fs.rm(ext.outDir, { recursive: true, force: true });
	}

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log("Failures:");
		for (const failure of counts.failures) console.log(`- ${failure}`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(2);
});
