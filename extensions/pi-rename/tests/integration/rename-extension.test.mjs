#!/usr/bin/env node
/**
 * Durable behavioral integration test for extensions/pi-rename/index.ts and its pure
 * helper extensions/pi-rename/derive-name.ts.
 *
 * Pins the public /rename contract:
 * - every applied name is a slug (lowercase, hyphen-separated, diacritics stripped)
 * - /rename <name> slugifies and sets the session name
 * - /rename with no arg, headless, derives a slug from the first user message
 * - /rename with no arg + UI prefills an input dialog: edit applies, empty accepts the
 *   suggestion, cancel (undefined) leaves the name unchanged
 * - empty/whitespace history falls back to a default name
 * - setSessionName failures are reported, not thrown
 * - the current name is shown as a persistent footer status label, kept in sync on
 *   session_start and cleared on session_shutdown
 * - the deterministic slug helpers behave correctly in isolation
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildRename() {
	return await buildExtension({
		name: "pi-rename-integration",
		src: path.join(REPO_ROOT, "extensions", "pi-rename", "index.ts"),
		outName: "rename.mjs",
		npx: "--yes",
	});
}

async function buildDeriveName() {
	return await buildExtension({
		name: "pi-rename-derive",
		src: path.join(REPO_ROOT, "extensions", "pi-rename", "derive-name.ts"),
		outName: "derive.mjs",
		npx: "--yes",
	});
}

function userEntry(content) {
	return { type: "message", message: { role: "user", content } };
}

function assistantEntry(text) {
	return { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } };
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
	const statuses = [];
	const ctx = {
		mode,
		hasUI,
		ui: {
			theme: { fg: (_color, text) => text },
			notify: (msg, type) => notes.push({ msg, type }),
			setStatus: (key, value) => statuses.push({ key, value }),
			input: async (title, placeholder) => {
				inputCalls.push({ title, placeholder });
				return inputResult;
			},
		},
		sessionManager: {
			getEntries: () => entries,
		},
	};
	ctx._notes = notes;
	ctx._inputCalls = inputCalls;
	ctx._statuses = statuses;
	return ctx;
}

async function fire(handlers, event, payload, ctx) {
	for (const handler of handlers.get(event) || []) await handler(payload, ctx);
}

async function scenarioSlugifyUnit(url) {
	const { slugify, deriveSessionName, DEFAULT_SESSION_NAME } = await loadModule(url);

	check("slugify trims", slugify("  hi  ") === "hi");
	check("slugify lowercases and hyphenates words", slugify("Refactor Auth Module") === "refactor-auth-module");
	check("slugify drops punctuation", slugify('"Hello World!"') === "hello-world");
	check("slugify collapses non-alnum runs", slugify("a   b\tc\nd--e") === "a-b-c-d-e");
	check("slugify strips diacritics", slugify("Café déjà vu") === "cafe-deja-vu");
	check("slugify empty stays empty", slugify("   ") === "");
	check("slugify non-ascii-only yields empty", slugify("日本語") === "");
	check("slugify is idempotent on a slug", slugify("refactor-auth") === "refactor-auth");
	check(
		"slugify respects maxWords",
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

	check(
		"deriveSessionName slugs the first user message",
		deriveSessionName([assistantEntry("ignored"), userEntry("Fix the login bug"), userEntry("second")]) ===
			"fix-the-login-bug",
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
		"deriveSessionName strips markdown markers via slug",
		deriveSessionName([userEntry("## **Important** task")]) === "important-task",
	);
	check(
		"deriveSessionName respects maxWords",
		deriveSessionName([userEntry("alpha beta gamma delta")], { maxWords: 2, maxChars: 100 }) === "alpha-beta",
	);
	check(
		"deriveSessionName skips empty user messages",
		deriveSessionName([userEntry("   "), userEntry("Real content here")]) === "real-content-here",
	);
	check("deriveSessionName falls back to default on empty history", deriveSessionName([]) === DEFAULT_SESSION_NAME);
	check(
		"deriveSessionName falls back to custom default",
		deriveSessionName([assistantEntry("only assistant")], { defaultName: "untitled" }) === "untitled",
	);
	check("deriveSessionName tolerates non-array input", deriveSessionName(null) === DEFAULT_SESSION_NAME);
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
	check(
		"/rename <name> sets a footer status label with the slug",
		ctx._statuses.some(
			(s) => s.key === "session-name" && typeof s.value === "string" && s.value.includes("refactor-auth"),
		),
		JSON.stringify(ctx._statuses),
	);

	await command.handler('  "  Hello   World!  "  ', ctx);
	check("/rename slugifies quotes and punctuation", harness.sessionName === "hello-world", harness.sessionName);
}

async function scenarioNoArgHeadless(url) {
	const renameExtension = await loadDefault(url);
	const harness = makePi();
	renameExtension(harness.pi);
	const command = harness.commands.get("rename");

	const ctx = makeCtx({ hasUI: false, entries: [userEntry("Investigate flaky CI pipeline")] });
	await command.handler("", ctx);
	check(
		"/rename no-arg headless derives a slug from the first user message",
		harness.sessionName === "investigate-flaky-ci-pipeline",
		harness.sessionName,
	);
	check("/rename no-arg headless does not open input dialog", ctx._inputCalls.length === 0);
	check("/rename headless sets no footer status (no UI)", ctx._statuses.length === 0);

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

	// User edits the suggestion.
	const h1 = makePi();
	renameExtension(h1.pi);
	const ctx1 = makeCtx({ hasUI: true, entries, inputResult: "My Custom Title" });
	await command(h1).handler("", ctx1);
	check("/rename UI edit applies a slug of the typed name", h1.sessionName === "my-custom-title", h1.sessionName);
	check(
		"/rename UI prefills slug suggestion as placeholder",
		ctx1._inputCalls.length === 1 && ctx1._inputCalls[0].placeholder === "build-the-rename-extension",
		JSON.stringify(ctx1._inputCalls),
	);

	// User submits empty -> accept suggestion.
	const h2 = makePi();
	renameExtension(h2.pi);
	const ctx2 = makeCtx({ hasUI: true, entries, inputResult: "" });
	await command(h2).handler("", ctx2);
	check(
		"/rename UI empty submit accepts the slug suggestion",
		h2.sessionName === "build-the-rename-extension",
		h2.sessionName,
	);

	// User cancels (undefined) -> no change.
	const h3 = makePi();
	renameExtension(h3.pi);
	const ctx3 = makeCtx({ hasUI: true, entries, inputResult: undefined });
	await command(h3).handler("", ctx3);
	check("/rename UI cancel leaves name unchanged", h3.sessionName === undefined, String(h3.sessionName));
	check(
		"/rename UI cancel notifies cancellation",
		ctx3._notes.some((n) => /cancel/i.test(n.msg)),
		JSON.stringify(ctx3._notes),
	);
	check("/rename UI cancel sets no footer status", ctx3._statuses.length === 0);
}

async function scenarioStatusLifecycle(url) {
	const renameExtension = await loadDefault(url);

	// session_start reflects an existing name in the footer.
	const h1 = makePi({ initialName: "existing-slug" });
	renameExtension(h1.pi);
	const ctx1 = makeCtx({ hasUI: true });
	await fire(h1.handlers, "session_start", {}, ctx1);
	check(
		"session_start shows the existing name as a footer label",
		ctx1._statuses.some((s) => s.key === "session-name" && String(s.value).includes("existing-slug")),
		JSON.stringify(ctx1._statuses),
	);

	// session_shutdown clears the footer label.
	const ctx2 = makeCtx({ hasUI: true });
	await fire(h1.handlers, "session_shutdown", {}, ctx2);
	check(
		"session_shutdown clears the footer label",
		ctx2._statuses.some((s) => s.key === "session-name" && s.value === undefined),
		JSON.stringify(ctx2._statuses),
	);
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
	const derive = await buildDeriveName();
	try {
		await scenarioSlugifyUnit(derive.url);
	} finally {
		await fs.rm(derive.outDir, { recursive: true, force: true });
	}

	const ext = await buildRename();
	try {
		await scenarioExplicitName(ext.url);
		await scenarioNoArgHeadless(ext.url);
		await scenarioNoArgUI(ext.url);
		await scenarioStatusLifecycle(ext.url);
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
