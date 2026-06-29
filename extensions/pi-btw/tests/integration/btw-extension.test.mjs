#!/usr/bin/env node
/**
 * Durable behavioral integration test for extensions/pi-btw/index.ts and its pure helper
 * (build-btw-context.ts).
 *
 * Pins the public /btw contract:
 * - /btw is registered with a description
 * - /btw with no argument prints a usage hint and does NOT call the model
 * - no model selected / unusable credentials are reported, and the model is not called
 * - /btw builds a one-shot request from the current branch + the question, with a system
 *   prompt and NO tools, and surfaces the model's text answer
 * - reasoning is passed ONLY for reasoning-capable models
 * - model error / aborted / empty answers are reported, not thrown
 * - TUI shows the scrollable overlay component (render + q-to-close), non-TUI prints
 * - CRITICALLY: the handler NEVER writes to the session (no pi.sendMessage / appendEntry /
 *   setSessionName, no sessionManager mutation) — the side question stays out of history
 * - the pure helper (extractMessages / buildBtwContext / extractAnswerText) behaves
 *
 * The model call is stubbed by aliasing "@earendil-works/pi-ai/compat" to a fake
 * completeSimple that records its arguments and returns a configurable AssistantMessage.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	bundle,
	createChecker,
	loadDefault,
	loadModule,
	makeBuildDir,
	STUB_SOURCES,
	sdkStub,
} from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

const DEFAULT_ANSWER = {
	role: "assistant",
	content: [{ type: "text", text: "STUB ANSWER" }],
	api: "test",
	provider: "test",
	model: "test-model",
	usage: {},
	stopReason: "stop",
	timestamp: 0,
};

/** Fake completeSimple: records every call and returns globalThis.__btwResponse or a default. */
const COMPAT_STUB =
	"export async function completeSimple(model, context, options) {\n" +
	"  (globalThis.__btwCalls ??= []).push({ model, context, options });\n" +
	"  const r = globalThis.__btwResponse;\n" +
	`  return r ?? ${JSON.stringify(DEFAULT_ANSWER)};\n` +
	"}\n" +
	"export function streamSimple() {}\n";

/** A theme whose styling helpers are identity functions, so render output is inspectable. */
function fakeTheme() {
	const id = (_color, text) => (text === undefined ? _color : text);
	return {
		fg: (_color, text) => text,
		bold: id,
		italic: id,
		strikethrough: id,
		underline: id,
	};
}

function makePi() {
	const commands = new Map();
	const calls = { sendMessage: 0, appendEntry: 0, setSessionName: 0 };
	let thinkingLevel = "medium";
	const pi = {
		registerCommand: (name, opts) => commands.set(name, opts),
		getThinkingLevel: () => thinkingLevel,
		// Spies: the handler must never touch these (no history pollution).
		sendMessage: () => {
			calls.sendMessage += 1;
		},
		appendEntry: () => {
			calls.appendEntry += 1;
		},
		setSessionName: () => {
			calls.setSessionName += 1;
		},
	};
	return { pi, commands, calls, setThinking: (lvl) => (thinkingLevel = lvl) };
}

function messageEntry(role, content) {
	return { type: "message", message: { role, content } };
}

function makeCtx({
	mode = "tui",
	hasUI = true,
	model = { provider: "anthropic", id: "claude", reasoning: false },
	entries = [],
	authOk = true,
	authError = "no key",
} = {}) {
	const notes = [];
	const overlays = [];
	const session = { appended: 0 };
	const ctx = {
		mode,
		hasUI,
		model,
		signal: undefined,
		sessionManager: {
			getBranch: () => entries,
			// Spies: the handler must only READ the branch, never mutate the session.
			appendMessage: () => {
				session.appended += 1;
			},
			appendEntry: () => {
				session.appended += 1;
			},
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () =>
				authOk ? { ok: true, apiKey: "test-key", headers: {}, env: {} } : { ok: false, error: authError },
		},
		ui: {
			notify: (message, type) => notes.push({ message, type }),
			setStatus: () => {},
			custom: async (factory) => {
				let closed = false;
				const tui = { requestRender() {}, terminal: { rows: 24 } };
				const component = await factory(tui, fakeTheme(), {}, () => {
					closed = true;
				});
				overlays.push({ component, getClosed: () => closed });
				return undefined;
			},
		},
	};
	return { ctx, notes, overlays, session };
}

function resetModelCalls() {
	globalThis.__btwCalls = [];
	globalThis.__btwResponse = undefined;
}

async function testPureHelper(pureUrl) {
	const mod = await loadModule(pureUrl);
	const { extractMessages, buildBtwContext, extractAnswerText, BTW_SYSTEM_PROMPT } = mod;

	const entries = [
		messageEntry("user", "Refactor the auth module"),
		{ type: "model_change", provider: "x", modelId: "y" },
		messageEntry("assistant", [{ type: "text", text: "Will do." }]),
	];

	const msgs = extractMessages(entries);
	check("extractMessages keeps only message entries", msgs.length === 2, JSON.stringify(msgs));
	check("extractMessages preserves roles in order", msgs[0]?.role === "user" && msgs[1]?.role === "assistant");

	const identity = (m) => m.map((x) => ({ ...x }));
	const ctx = buildBtwContext({ entries, convertToLlm: identity, question: "what did we decide?" });
	check(
		"buildBtwContext uses the btw system prompt",
		ctx.systemPrompt === BTW_SYSTEM_PROMPT && typeof BTW_SYSTEM_PROMPT === "string",
	);
	check("buildBtwContext carries NO tools", !("tools" in ctx));
	const last = ctx.messages[ctx.messages.length - 1];
	check(
		"buildBtwContext appends the question as final user message",
		last?.role === "user" && last?.content === "what did we decide?",
		JSON.stringify(last),
	);
	check("buildBtwContext keeps the conversation before the question", ctx.messages.length === 3);

	const answer = extractAnswerText({
		content: [
			{ type: "text", text: "a" },
			{ type: "thinking", thinking: "ignored" },
			{ type: "text", text: "b" },
		],
	});
	check("extractAnswerText joins text blocks, ignores others", answer === "a\n\nb", JSON.stringify(answer));
	check(
		"extractAnswerText trims empties to ''",
		extractAnswerText({ content: [{ type: "thinking", thinking: "x" }] }) === "",
	);
}

async function testRegistration(url) {
	const ext = await loadDefault(url);
	const { pi, commands } = makePi();
	ext(pi);
	const cmd = commands.get("btw");
	check("/btw command is registered", typeof cmd?.handler === "function");
	check("/btw has a description", typeof cmd?.description === "string" && cmd.description.length > 0);
}

async function testEmptyQuestion(url) {
	resetModelCalls();
	const ext = await loadDefault(url);
	const { pi, commands } = makePi();
	ext(pi);
	const { ctx, notes } = makeCtx({ mode: "tui", hasUI: true });
	await commands.get("btw").handler("   ", ctx);
	check(
		"empty /btw shows a usage hint",
		notes.some((n) => n.type === "info" && /usage:\s*\/btw/i.test(n.message)),
		JSON.stringify(notes),
	);
	check("empty /btw does not call the model", (globalThis.__btwCalls ?? []).length === 0);
}

async function testNoModel(url) {
	resetModelCalls();
	const ext = await loadDefault(url);
	const { pi, commands } = makePi();
	ext(pi);
	const { ctx, notes } = makeCtx({ model: null });
	await commands.get("btw").handler("what file was that?", ctx);
	check(
		"no model selected is reported",
		notes.some((n) => n.type === "error" && /no model/i.test(n.message)),
		JSON.stringify(notes),
	);
	check("no model does not call the model", (globalThis.__btwCalls ?? []).length === 0);
}

async function testAuthFailure(url) {
	resetModelCalls();
	const ext = await loadDefault(url);
	const { pi, commands } = makePi();
	ext(pi);
	const { ctx, notes } = makeCtx({ authOk: false, authError: "no creds" });
	await commands.get("btw").handler("what happened?", ctx);
	check(
		"auth failure is reported with the error",
		notes.some((n) => n.type === "error" && /no creds/.test(n.message)),
		JSON.stringify(notes),
	);
	check("auth failure does not call the model", (globalThis.__btwCalls ?? []).length === 0);
}

async function testHappyPathContract(url) {
	resetModelCalls();
	const ext = await loadDefault(url);
	const { pi, commands, calls } = makePi();
	ext(pi);
	const entries = [messageEntry("user", "Refactor auth"), messageEntry("assistant", [{ type: "text", text: "ok" }])];
	const { ctx } = makeCtx({
		mode: "print",
		hasUI: false,
		entries,
		model: { provider: "anthropic", id: "claude", reasoning: false },
	});

	const out = [];
	const orig = console.log;
	console.log = (m) => out.push(String(m));
	try {
		await commands.get("btw").handler("what did we agree to do?", ctx);
	} finally {
		console.log = orig;
	}

	const callList = globalThis.__btwCalls ?? [];
	check("/btw calls completeSimple once", callList.length === 1, `calls=${callList.length}`);
	const call = callList[0];
	check("/btw passes the current model", call?.model?.id === "claude");
	check(
		"/btw sends a system prompt",
		typeof call?.context?.systemPrompt === "string" && call.context.systemPrompt.length > 0,
	);
	check("/btw sends NO tools", !("tools" in (call?.context ?? {})), JSON.stringify(Object.keys(call?.context ?? {})));
	check(
		"/btw appends the question as final user message",
		call?.context?.messages?.at(-1)?.content === "what did we agree to do?",
	);
	check("/btw includes the prior conversation in context", (call?.context?.messages?.length ?? 0) === 3);
	check("/btw passes resolved apiKey", call?.options?.apiKey === "test-key");
	check("/btw caps maxTokens", typeof call?.options?.maxTokens === "number" && call.options.maxTokens > 0);
	check(
		"/btw omits reasoning for non-reasoning model",
		!("reasoning" in (call?.options ?? {})),
		JSON.stringify(call?.options),
	);
	check(
		"/btw prints the answer in print mode",
		out.some((l) => l.includes("STUB ANSWER")),
		JSON.stringify(out),
	);
	check(
		"/btw never persists via pi (sendMessage/appendEntry/setSessionName)",
		calls.sendMessage === 0 && calls.appendEntry === 0 && calls.setSessionName === 0,
		JSON.stringify(calls),
	);
}

async function testReasoningModel(url) {
	resetModelCalls();
	const ext = await loadDefault(url);
	const { pi, commands, setThinking } = makePi();
	setThinking("high");
	ext(pi);
	const { ctx } = makeCtx({
		mode: "print",
		hasUI: false,
		model: { provider: "anthropic", id: "claude", reasoning: true },
		entries: [],
	});
	await commands.get("btw").handler("ping", ctx);
	const call = (globalThis.__btwCalls ?? [])[0];
	check(
		"/btw passes reasoning for reasoning-capable model",
		call?.options?.reasoning === "high",
		JSON.stringify(call?.options),
	);
}

async function testModelErrors(url) {
	const ext = await loadDefault(url);
	const { pi, commands } = makePi();
	ext(pi);

	// stopReason "error"
	resetModelCalls();
	globalThis.__btwResponse = { content: [], stopReason: "error", errorMessage: "boom", role: "assistant", usage: {} };
	let r = makeCtx({ mode: "tui", hasUI: true, entries: [] });
	await commands.get("btw").handler("q", r.ctx);
	check(
		"model error is reported with the message",
		r.notes.some((n) => n.type === "error" && /boom/.test(n.message)),
		JSON.stringify(r.notes),
	);
	check("model error opens no overlay", r.overlays.length === 0);

	// empty answer (stop, but no text)
	resetModelCalls();
	globalThis.__btwResponse = {
		content: [{ type: "thinking", thinking: "x" }],
		stopReason: "stop",
		role: "assistant",
		usage: {},
	};
	r = makeCtx({ mode: "tui", hasUI: true, entries: [] });
	await commands.get("btw").handler("q", r.ctx);
	check(
		"empty answer is reported as a warning",
		r.notes.some((n) => n.type === "warning" && /no answer/i.test(n.message)),
		JSON.stringify(r.notes),
	);
	check("empty answer opens no overlay", r.overlays.length === 0);

	// aborted
	resetModelCalls();
	globalThis.__btwResponse = { content: [], stopReason: "aborted", role: "assistant", usage: {} };
	r = makeCtx({ mode: "tui", hasUI: true, entries: [] });
	await commands.get("btw").handler("q", r.ctx);
	check(
		"aborted is reported as info",
		r.notes.some((n) => n.type === "info" && /cancel/i.test(n.message)),
		JSON.stringify(r.notes),
	);
}

async function testTuiOverlay(url) {
	resetModelCalls();
	const ext = await loadDefault(url);
	const { pi, commands } = makePi();
	ext(pi);
	const { ctx, overlays } = makeCtx({ mode: "tui", hasUI: true, entries: [] });
	await commands.get("btw").handler("what is the plan?", ctx);
	check("/btw opens exactly one overlay in the TUI", overlays.length === 1);
	const comp = overlays[0]?.component;
	check("overlay component has render()", typeof comp?.render === "function");
	check("overlay component has handleInput()", typeof comp?.handleInput === "function");
	let lines;
	try {
		lines = comp.render(80);
	} catch (e) {
		lines = e;
	}
	check("overlay render() returns lines without throwing", Array.isArray(lines), String(lines));
	comp?.handleInput?.("q");
	check("overlay closes on q", overlays[0]?.getClosed() === true);
}

async function main() {
	const { outDir, aliases } = await makeBuildDir("pi-btw-integration", {
		sdk: (dir) => sdkStub(dir),
		tui: `${STUB_SOURCES.tui}export class Markdown { constructor() {} render() { return []; } invalidate() {} }\n`,
	});

	// index.ts imports convertToLlm from the SDK at runtime; the stub identity is enough.
	await fs.appendFile(
		aliases["@earendil-works/pi-coding-agent"],
		"export function convertToLlm(messages) { return messages; }\n",
	);

	// Stub the one-shot model call.
	const compatFile = path.join(outDir, "stub-ai-compat.mjs");
	await fs.writeFile(compatFile, COMPAT_STUB);
	aliases["@earendil-works/pi-ai/compat"] = compatFile;

	const url = await bundle({
		src: path.join(REPO_ROOT, "extensions", "pi-btw", "index.ts"),
		outDir,
		outName: "btw.mjs",
		aliases,
	});
	const pureUrl = await bundle({
		src: path.join(REPO_ROOT, "extensions", "pi-btw", "build-btw-context.ts"),
		outDir,
		outName: "build-btw-context.mjs",
		aliases: {},
	});

	try {
		await testPureHelper(pureUrl);
		await testRegistration(url);
		await testEmptyQuestion(url);
		await testNoModel(url);
		await testAuthFailure(url);
		await testHappyPathContract(url);
		await testReasoningModel(url);
		await testModelErrors(url);
		await testTuiOverlay(url);
	} finally {
		await fs.rm(outDir, { recursive: true, force: true });
	}

	console.log(`\n=== pi-btw: ${counts.passed} passed, ${counts.failed} failed ===`);
	if (counts.failed > 0) {
		for (const f of counts.failures) console.log(`  FAIL ${f}`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(2);
});
