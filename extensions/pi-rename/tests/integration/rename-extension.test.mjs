#!/usr/bin/env node
/**
 * Durable behavioral integration test for extensions/pi-rename/index.ts and its pure
 * helper extensions/pi-rename/derive-name.ts.
 *
 * Pins the public /rename contract:
 * - /rename <name> sets the normalized session name (trim, wrapping quotes, whitespace)
 * - /rename with no arg, headless, derives a name from the first user message
 * - /rename with no arg + UI prefills an input dialog: edit applies, empty accepts the
 *   suggestion, cancel (undefined) leaves the name unchanged
 * - empty/whitespace history falls back to a default name
 * - setSessionName failures are reported, not thrown
 * - the deterministic derive-name helpers behave correctly in isolation
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

function makePi({ throwOnSet = false } = {}) {
	let sessionName;
	const commands = new Map();
	const pi = {
		registerCommand: (name, opts) => commands.set(name, opts),
		setSessionName: (name) => {
			if (throwOnSet) throw new Error("boom");
			sessionName = name;
		},
		getSessionName: () => sessionName,
	};
	return {
		pi,
		commands,
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
		sessionManager: {
			getEntries: () => entries,
		},
	};
	ctx._notes = notes;
	ctx._inputCalls = inputCalls;
	return ctx;
}

async function scenarioDeriveNameUnit(url) {
	const { normalizeName, deriveSessionName, DEFAULT_SESSION_NAME } = await loadModule(url);

	check("normalizeName trims", normalizeName("  hi  ") === "hi");
	check("normalizeName strips wrapping double quotes", normalizeName('"hello world"') === "hello world");
	check("normalizeName strips wrapping single quotes", normalizeName("'hello'") === "hello");
	check("normalizeName collapses internal whitespace", normalizeName("a   b\tc\nd") === "a b c d");
	check(
		"normalizeName preserves legitimate internal spaces",
		normalizeName('  "Refactor   auth module"  ') === "Refactor auth module",
	);
	check("normalizeName empty stays empty", normalizeName("   ") === "");

	check(
		"deriveSessionName uses first user message",
		deriveSessionName([assistantEntry("ignored"), userEntry("Fix the login bug"), userEntry("second")]) ===
			"Fix the login bug",
	);
	check(
		"deriveSessionName joins text blocks and ignores images",
		deriveSessionName([
			userEntry([
				{ type: "image", data: "x", mimeType: "image/png" },
				{ type: "text", text: "Add dark mode" },
			]),
		]) === "Add dark mode",
	);
	check(
		"deriveSessionName strips a leading slash-command token",
		deriveSessionName([userEntry("/explain the cache layer")]) === "the cache layer",
	);
	check(
		"deriveSessionName strips simple markdown markers",
		deriveSessionName([userEntry("## **Important** task")]) === "Important task",
	);
	check(
		"deriveSessionName truncates on a word boundary",
		(() => {
			const out = deriveSessionName([userEntry("one two three four five six")], { maxChars: 12, maxWords: 8 });
			return out === "one two" && out.length <= 12;
		})(),
	);
	check(
		"deriveSessionName respects maxWords",
		deriveSessionName([userEntry("alpha beta gamma delta")], { maxWords: 2, maxChars: 100 }) === "alpha beta",
	);
	check(
		"deriveSessionName skips empty user messages",
		deriveSessionName([userEntry("   "), userEntry("real content here")]) === "real content here",
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
	await command.handler("Refactor auth", ctx);
	check("/rename <name> sets the session name", harness.sessionName === "Refactor auth", harness.sessionName);
	check(
		"/rename <name> notifies success",
		ctx._notes.some((n) => n.type === "info" && /renamed to "Refactor auth"/.test(n.msg)),
		JSON.stringify(ctx._notes),
	);
	check("/rename <name> does not open the input dialog", ctx._inputCalls.length === 0);

	await command.handler('  "  hello   world  "  ', ctx);
	check("/rename normalizes quotes and whitespace", harness.sessionName === "hello world", harness.sessionName);
}

async function scenarioNoArgHeadless(url) {
	const renameExtension = await loadDefault(url);
	const harness = makePi();
	renameExtension(harness.pi);
	const command = harness.commands.get("rename");

	const ctx = makeCtx({ hasUI: false, entries: [userEntry("Investigate flaky CI pipeline")] });
	await command.handler("", ctx);
	check(
		"/rename no-arg headless derives from first user message",
		harness.sessionName === "Investigate flaky CI pipeline",
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
		harness2.sessionName === "Spaces only arg path",
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
	const ctx1 = makeCtx({ hasUI: true, entries, inputResult: "My custom title" });
	await command(h1).handler("", ctx1);
	check("/rename UI edit applies typed name", h1.sessionName === "My custom title", h1.sessionName);
	check(
		"/rename UI prefills suggestion as placeholder",
		ctx1._inputCalls.length === 1 && ctx1._inputCalls[0].placeholder === "Build the rename extension",
		JSON.stringify(ctx1._inputCalls),
	);

	// User submits empty -> accept suggestion.
	const h2 = makePi();
	renameExtension(h2.pi);
	const ctx2 = makeCtx({ hasUI: true, entries, inputResult: "" });
	await command(h2).handler("", ctx2);
	check("/rename UI empty submit accepts suggestion", h2.sessionName === "Build the rename extension", h2.sessionName);

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
}

async function scenarioFallbacksAndErrors(url) {
	const renameExtension = await loadDefault(url);

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

	function command(h) {
		return h.commands.get("rename");
	}
}

async function main() {
	const derive = await buildDeriveName();
	try {
		await scenarioDeriveNameUnit(derive.url);
	} finally {
		await fs.rm(derive.outDir, { recursive: true, force: true });
	}

	const ext = await buildRename();
	try {
		await scenarioExplicitName(ext.url);
		await scenarioNoArgHeadless(ext.url);
		await scenarioNoArgUI(ext.url);
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
