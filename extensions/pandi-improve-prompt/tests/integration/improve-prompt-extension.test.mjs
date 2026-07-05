#!/usr/bin/env node
/**
 * Durable behavioral integration test for extensions/pandi-improve-prompt/index.ts and its
 * pure helper (build-improve-context.ts).
 *
 * Pins the public /improve-prompt contract:
 * - /improve-prompt is registered with a description
 * - /improve-prompt with no argument prints a usage hint and does NOT call the model
 * - no model selected / unusable credentials are reported, and the model is not called
 * - /improve-prompt builds a one-shot request from JUST the draft (no conversation
 *   context), with a system prompt and NO tools, and surfaces the model's rewrite
 * - reasoning is passed ONLY for reasoning-capable models
 * - model error / aborted / empty rewrites are reported, not thrown
 * - print/json: the rewrite is printed and NOTHING is sent (no interactive confirm exists)
 * - TUI: the scrollable overlay shows before the confirm; confirming SENDS the rewrite via
 *   pi.sendUserMessage (idle -> direct, mid-stream -> followUp); declining sends nothing
 * - rpc (hasUI, no TUI overlay): notify() carries the rewrite, then the same confirm/send
 * - the pure helper (buildImproveContext / extractImprovedText) behaves
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
	content: [{ type: "text", text: "IMPROVED PROMPT" }],
	api: "test",
	provider: "test",
	model: "test-model",
	usage: {},
	stopReason: "stop",
	timestamp: 0,
};

/** Fake completeSimple: records every call and returns globalThis.__improveResponse or a default. */
const COMPAT_STUB =
	"export async function completeSimple(model, context, options) {\n" +
	"  (globalThis.__improveCalls ??= []).push({ model, context, options });\n" +
	"  const r = globalThis.__improveResponse;\n" +
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
	const sendCalls = [];
	let thinkingLevel = "medium";
	const pi = {
		registerCommand: (name, opts) => commands.set(name, opts),
		getThinkingLevel: () => thinkingLevel,
		sendUserMessage: (content, options) => {
			sendCalls.push({ content, options });
		},
	};
	return { pi, commands, sendCalls, setThinking: (lvl) => (thinkingLevel = lvl) };
}

function makeCtx({
	mode = "tui",
	hasUI = true,
	model = { provider: "anthropic", id: "claude", reasoning: false },
	authOk = true,
	authError = "no key",
	idle = true,
	confirmResult = true,
} = {}) {
	const notes = [];
	const overlays = [];
	const confirmCalls = [];
	const ctx = {
		mode,
		hasUI,
		model,
		signal: undefined,
		isIdle: () => idle,
		modelRegistry: {
			getApiKeyAndHeaders: async () =>
				authOk ? { ok: true, apiKey: "test-key", headers: {}, env: {} } : { ok: false, error: authError },
		},
		ui: {
			notify: (message, type) => notes.push({ message, type }),
			setStatus: () => {},
			confirm: async (title, message) => {
				confirmCalls.push({ title, message });
				return confirmResult;
			},
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
	return { ctx, notes, overlays, confirmCalls };
}

function resetModelCalls() {
	globalThis.__improveCalls = [];
	globalThis.__improveResponse = undefined;
}

async function testPureHelper(pureUrl) {
	const mod = await loadModule(pureUrl);
	const { buildImproveContext, extractImprovedText, IMPROVE_PROMPT_SYSTEM_PROMPT } = mod;

	const ctx = buildImproveContext("fix the bug in the parser");
	check(
		"buildImproveContext uses the improve-prompt system prompt",
		ctx.systemPrompt === IMPROVE_PROMPT_SYSTEM_PROMPT && typeof IMPROVE_PROMPT_SYSTEM_PROMPT === "string",
	);
	check("buildImproveContext carries NO tools", !("tools" in ctx));
	check(
		"buildImproveContext sends ONLY the draft as a single user message",
		ctx.messages.length === 1 &&
			ctx.messages[0]?.role === "user" &&
			ctx.messages[0]?.content === "fix the bug in the parser",
		JSON.stringify(ctx.messages),
	);

	const answer = extractImprovedText({
		content: [
			{ type: "text", text: "a" },
			{ type: "thinking", thinking: "ignored" },
			{ type: "text", text: "b" },
		],
	});
	check("extractImprovedText joins text blocks, ignores others", answer === "a\n\nb", JSON.stringify(answer));
	check(
		"extractImprovedText trims empties to ''",
		extractImprovedText({ content: [{ type: "thinking", thinking: "x" }] }) === "",
	);
}

async function testRegistration(url) {
	const ext = await loadDefault(url);
	const { pi, commands } = makePi();
	ext(pi);
	const cmd = commands.get("improve-prompt");
	check("/improve-prompt command is registered", typeof cmd?.handler === "function");
	check("/improve-prompt has a description", typeof cmd?.description === "string" && cmd.description.length > 0);
}

async function testEmptyDraft(url) {
	resetModelCalls();
	const ext = await loadDefault(url);
	const { pi, commands } = makePi();
	ext(pi);
	const { ctx, notes } = makeCtx({ mode: "tui", hasUI: true });
	await commands.get("improve-prompt").handler("   ", ctx);
	check(
		"empty /improve-prompt shows a usage hint",
		notes.some((n) => n.type === "info" && /usage:\s*\/improve-prompt/i.test(n.message)),
		JSON.stringify(notes),
	);
	check("empty /improve-prompt does not call the model", (globalThis.__improveCalls ?? []).length === 0);
}

async function testNoModel(url) {
	resetModelCalls();
	const ext = await loadDefault(url);
	const { pi, commands } = makePi();
	ext(pi);
	const { ctx, notes } = makeCtx({ model: null });
	await commands.get("improve-prompt").handler("fix the bug", ctx);
	check(
		"no model selected is reported",
		notes.some((n) => n.type === "error" && /no model/i.test(n.message)),
		JSON.stringify(notes),
	);
	check("no model does not call the model", (globalThis.__improveCalls ?? []).length === 0);
}

async function testJsonModeNotifyReachesConsole(url) {
	resetModelCalls();
	const ext = await loadDefault(url);
	const { pi, commands } = makePi();
	ext(pi);
	const { ctx } = makeCtx({ mode: "json", hasUI: false, model: null });

	const errOut = [];
	const origErr = console.error;
	console.error = (m) => errOut.push(String(m));
	try {
		await commands.get("improve-prompt").handler("fix the bug", ctx);
	} finally {
		console.error = origErr;
	}
	check(
		"json mode: an error notify is written to the console (not silently dropped)",
		errOut.some((m) => /no model/i.test(m)),
		JSON.stringify(errOut),
	);
}

async function testAuthFailure(url) {
	resetModelCalls();
	const ext = await loadDefault(url);
	const { pi, commands } = makePi();
	ext(pi);
	const { ctx, notes } = makeCtx({ authOk: false, authError: "no creds" });
	await commands.get("improve-prompt").handler("fix the bug", ctx);
	check(
		"auth failure is reported with the error",
		notes.some((n) => n.type === "error" && /no creds/.test(n.message)),
		JSON.stringify(notes),
	);
	check("auth failure does not call the model", (globalThis.__improveCalls ?? []).length === 0);
}

async function testHappyPathPrintMode(url) {
	resetModelCalls();
	const ext = await loadDefault(url);
	const { pi, commands, sendCalls } = makePi();
	ext(pi);
	const { ctx } = makeCtx({
		mode: "print",
		hasUI: false,
		model: { provider: "anthropic", id: "claude", reasoning: false },
	});

	const out = [];
	const orig = console.log;
	console.log = (m) => out.push(String(m));
	try {
		await commands.get("improve-prompt").handler("fix the bug in the parser", ctx);
	} finally {
		console.log = orig;
	}

	const callList = globalThis.__improveCalls ?? [];
	check("/improve-prompt calls completeSimple once", callList.length === 1, `calls=${callList.length}`);
	const call = callList[0];
	check("/improve-prompt passes the current model", call?.model?.id === "claude");
	check(
		"/improve-prompt sends a system prompt",
		typeof call?.context?.systemPrompt === "string" && call.context.systemPrompt.length > 0,
	);
	check("/improve-prompt sends NO tools", !("tools" in (call?.context ?? {})));
	check(
		"/improve-prompt sends only the draft as the (single) user message",
		call?.context?.messages?.length === 1 && call.context.messages[0]?.content === "fix the bug in the parser",
	);
	check("/improve-prompt passes resolved apiKey", call?.options?.apiKey === "test-key");
	check("/improve-prompt caps maxTokens", typeof call?.options?.maxTokens === "number" && call.options.maxTokens > 0);
	check(
		"/improve-prompt omits reasoning for non-reasoning model",
		!("reasoning" in (call?.options ?? {})),
		JSON.stringify(call?.options),
	);
	check(
		"/improve-prompt prints the rewrite in print mode",
		out.some((l) => l.includes("IMPROVED PROMPT")),
		JSON.stringify(out),
	);
	check(
		"print mode NEVER sends the rewrite (no interactive confirm exists)",
		sendCalls.length === 0,
		JSON.stringify(sendCalls),
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
	});
	await commands.get("improve-prompt").handler("ping", ctx);
	const call = (globalThis.__improveCalls ?? [])[0];
	check(
		"/improve-prompt passes reasoning for reasoning-capable model",
		call?.options?.reasoning === "high",
		JSON.stringify(call?.options),
	);
}

async function testModelErrors(url) {
	const ext = await loadDefault(url);
	const { pi, commands } = makePi();
	ext(pi);

	resetModelCalls();
	globalThis.__improveResponse = {
		content: [],
		stopReason: "error",
		errorMessage: "boom",
		role: "assistant",
		usage: {},
	};
	let r = makeCtx({ mode: "tui", hasUI: true });
	await commands.get("improve-prompt").handler("q", r.ctx);
	check(
		"model error is reported with the message",
		r.notes.some((n) => n.type === "error" && /boom/.test(n.message)),
		JSON.stringify(r.notes),
	);
	check("model error opens no overlay", r.overlays.length === 0);

	resetModelCalls();
	globalThis.__improveResponse = {
		content: [{ type: "thinking", thinking: "x" }],
		stopReason: "stop",
		role: "assistant",
		usage: {},
	};
	r = makeCtx({ mode: "tui", hasUI: true });
	await commands.get("improve-prompt").handler("q", r.ctx);
	check(
		"empty rewrite is reported as a warning",
		r.notes.some((n) => n.type === "warning" && /no rewrite/i.test(n.message)),
		JSON.stringify(r.notes),
	);
	check("empty rewrite opens no overlay", r.overlays.length === 0);

	resetModelCalls();
	globalThis.__improveResponse = { content: [], stopReason: "aborted", role: "assistant", usage: {} };
	r = makeCtx({ mode: "tui", hasUI: true });
	await commands.get("improve-prompt").handler("q", r.ctx);
	check(
		"aborted is reported as info",
		r.notes.some((n) => n.type === "info" && /cancel/i.test(n.message)),
		JSON.stringify(r.notes),
	);
}

async function testTuiOverlayThenSendConfirmed(url) {
	resetModelCalls();
	const ext = await loadDefault(url);
	const { pi, commands, sendCalls } = makePi();
	ext(pi);
	const { ctx, overlays, confirmCalls } = makeCtx({ mode: "tui", hasUI: true, idle: true, confirmResult: true });
	await commands.get("improve-prompt").handler("fix the bug", ctx);

	check("/improve-prompt opens exactly one overlay in the TUI", overlays.length === 1);
	const comp = overlays[0]?.component;
	check("overlay component has render()", typeof comp?.render === "function");
	let lines;
	try {
		lines = comp.render(80);
	} catch (e) {
		lines = e;
	}
	check("overlay render() returns lines without throwing", Array.isArray(lines), String(lines));
	comp?.handleInput?.("q");
	check("overlay closes on q", overlays[0]?.getClosed() === true);

	check("confirm is asked exactly once", confirmCalls.length === 1, JSON.stringify(confirmCalls));
	check(
		"confirming SENDS the rewrite via pi.sendUserMessage (idle -> direct call)",
		sendCalls.length === 1 && sendCalls[0]?.content === "IMPROVED PROMPT" && sendCalls[0]?.options === undefined,
		JSON.stringify(sendCalls),
	);
}

async function testTuiSendWhileBusyUsesFollowUp(url) {
	resetModelCalls();
	const ext = await loadDefault(url);
	const { pi, commands, sendCalls } = makePi();
	ext(pi);
	const { ctx } = makeCtx({ mode: "tui", hasUI: true, idle: false, confirmResult: true });
	await commands.get("improve-prompt").handler("fix the bug", ctx);
	check(
		"mid-stream confirm sends as a followUp (not a direct steer)",
		sendCalls.length === 1 && sendCalls[0]?.options?.deliverAs === "followUp",
		JSON.stringify(sendCalls),
	);
}

async function testTuiDeclineNeverSends(url) {
	resetModelCalls();
	const ext = await loadDefault(url);
	const { pi, commands, sendCalls } = makePi();
	ext(pi);
	const { ctx, notes } = makeCtx({ mode: "tui", hasUI: true, confirmResult: false });
	await commands.get("improve-prompt").handler("fix the bug", ctx);
	check("declining the confirm sends nothing", sendCalls.length === 0, JSON.stringify(sendCalls));
	check(
		"declining is reported (not sent)",
		notes.some((n) => n.type === "info" && /not sent/i.test(n.message)),
		JSON.stringify(notes),
	);
}

async function testRpcNotifiesThenSends(url) {
	resetModelCalls();
	const ext = await loadDefault(url);
	const { pi, commands, sendCalls } = makePi();
	ext(pi);
	const { ctx, notes, overlays, confirmCalls } = makeCtx({ mode: "rpc", hasUI: true, confirmResult: true });
	await commands.get("improve-prompt").handler("fix the bug", ctx);
	check("rpc mode opens no TUI overlay (custom())", overlays.length === 0);
	check(
		"rpc mode notifies the rewrite before confirming",
		notes.some((n) => n.type === "info" && /IMPROVED PROMPT/.test(n.message)),
		JSON.stringify(notes),
	);
	check("rpc mode still asks to confirm", confirmCalls.length === 1);
	check("rpc mode sends on confirm", sendCalls.length === 1, JSON.stringify(sendCalls));
}

async function main() {
	const { outDir, aliases } = await makeBuildDir("pandi-improve-prompt-integration", {
		sdk: (dir) => sdkStub(dir),
		tui: STUB_SOURCES.tui,
	});

	const compatFile = path.join(outDir, "stub-ai-compat.mjs");
	await fs.writeFile(compatFile, COMPAT_STUB);
	aliases["@earendil-works/pi-ai/compat"] = compatFile;

	const url = await bundle({
		src: path.join(REPO_ROOT, "extensions", "pandi-improve-prompt", "index.ts"),
		outDir,
		outName: "improve-prompt.mjs",
		aliases,
	});
	const pureUrl = await bundle({
		src: path.join(REPO_ROOT, "extensions", "pandi-improve-prompt", "build-improve-context.ts"),
		outDir,
		outName: "build-improve-context.mjs",
		aliases: {},
	});

	try {
		await testPureHelper(pureUrl);
		await testRegistration(url);
		await testEmptyDraft(url);
		await testNoModel(url);
		await testJsonModeNotifyReachesConsole(url);
		await testAuthFailure(url);
		await testHappyPathPrintMode(url);
		await testReasoningModel(url);
		await testModelErrors(url);
		await testTuiOverlayThenSendConfirmed(url);
		await testTuiSendWhileBusyUsesFollowUp(url);
		await testTuiDeclineNeverSends(url);
		await testRpcNotifiesThenSends(url);
	} finally {
		await fs.rm(outDir, { recursive: true, force: true });
	}

	console.log(`\n=== pandi-improve-prompt: ${counts.passed} passed, ${counts.failed} failed ===`);
	if (counts.failed > 0) {
		for (const f of counts.failures) console.log(`  FAIL ${f}`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(2);
});
