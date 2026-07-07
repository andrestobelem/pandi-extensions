#!/usr/bin/env node
/**
 * Prueba de integración conductual persistente para extensions/pandi-improve-prompt/index.ts y su
 * ayudante puro (build-improve-context.ts).
 *
 * Deja fijado el contrato público de /improve-prompt:
 * - /improve-prompt queda registrado con una descripción
 * - /improve-prompt sin argumento imprime una ayuda de uso y NO llama al modelo
 * - se informan el modelo no seleccionado / las credenciales inutilizables, y el modelo no se llama
 * - /improve-prompt arma una solicitud de una sola pasada solo con el borrador (sin contexto
 *   de conversación), con un prompt del sistema y SIN herramientas, y expone la reescritura del modelo
 * - reasoning se pasa SOLO para modelos compatibles con reasoning
 * - los errores del modelo / los abortos / las reescrituras vacías se informan, no se lanzan
 * - print/json: la reescritura se imprime y NO se envía nada (no existe confirmación interactiva)
 * - TUI: el overlay desplazable se muestra antes de la confirmación; al confirmar ENVÍA la reescritura vía
 *   pi.sendUserMessage (idle -> directo, mid-stream -> followUp); al rechazar no envía nada
 * - rpc (hasUI, sin overlay de TUI): notify() lleva la reescritura, luego el mismo confirm/send
 * - el ayudante puro (buildImproveContext / extractImprovedText) se comporta
 *
 * La llamada al modelo se stubbea aliasando "@earendil-works/pi-ai/compat" a un completeSimple falso
 * que registra sus argumentos y devuelve un AssistantMessage configurable.
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

/** completeSimple falso: registra cada llamada y devuelve globalThis.__improveResponse o un valor por defecto. */
const COMPAT_STUB =
	"export async function completeSimple(model, context, options) {\n" +
	"  (globalThis.__improveCalls ??= []).push({ model, context, options });\n" +
	"  const r = globalThis.__improveResponse;\n" +
	`  return r ?? ${JSON.stringify(DEFAULT_ANSWER)};\n` +
	"}\n" +
	"export function streamSimple() {}\n";

/** Un tema cuyos helpers de estilo son funciones identidad, así el resultado del render se puede inspeccionar. */
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
	authError = "sin credenciales",
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
		"buildImproveContext usa el prompt del sistema de improve-prompt",
		ctx.systemPrompt === IMPROVE_PROMPT_SYSTEM_PROMPT && typeof IMPROVE_PROMPT_SYSTEM_PROMPT === "string",
	);
	check("buildImproveContext no lleva herramientas", !("tools" in ctx));
	check(
		"buildImproveContext envía SOLO el borrador como un único mensaje de usuario",
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
	check(
		"extractImprovedText une los bloques de texto e ignora los demás",
		answer === "a\n\nb",
		JSON.stringify(answer),
	);
	check(
		"extractImprovedText recorta los vacíos a ''",
		extractImprovedText({ content: [{ type: "thinking", thinking: "x" }] }) === "",
	);
}

async function testRegistration(url) {
	const ext = await loadDefault(url);
	const { pi, commands } = makePi();
	ext(pi);
	const cmd = commands.get("improve-prompt");
	check("/improve-prompt queda registrado", typeof cmd?.handler === "function");
	check("/improve-prompt tiene una descripción", typeof cmd?.description === "string" && cmd.description.length > 0);
}

async function testEmptyDraft(url) {
	resetModelCalls();
	const ext = await loadDefault(url);
	const { pi, commands } = makePi();
	ext(pi);
	const { ctx, notes } = makeCtx({ mode: "tui", hasUI: true });
	await commands.get("improve-prompt").handler("   ", ctx);
	check(
		"un /improve-prompt vacío muestra una ayuda de uso",
		notes.some((n) => n.type === "info" && /uso:\s*\/improve-prompt/i.test(n.message)),
		JSON.stringify(notes),
	);
	check("un /improve-prompt vacío no llama al modelo", (globalThis.__improveCalls ?? []).length === 0);
}

async function testNoModel(url) {
	resetModelCalls();
	const ext = await loadDefault(url);
	const { pi, commands } = makePi();
	ext(pi);
	const { ctx, notes } = makeCtx({ model: null });
	await commands.get("improve-prompt").handler("fix the bug", ctx);
	check(
		"se informa que no hay modelo seleccionado",
		notes.some((n) => n.type === "error" && /no hay modelo/i.test(n.message)),
		JSON.stringify(notes),
	);
	check("sin modelo no se llama al modelo", (globalThis.__improveCalls ?? []).length === 0);
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
		"modo json: una notificación de error se escribe en la consola (no se descarta en silencio)",
		errOut.some((m) => /no hay modelo/i.test(m)),
		JSON.stringify(errOut),
	);
}

async function testAuthFailure(url) {
	resetModelCalls();
	const ext = await loadDefault(url);
	const { pi, commands } = makePi();
	ext(pi);
	const { ctx, notes } = makeCtx({ authOk: false, authError: "sin credenciales" });
	await commands.get("improve-prompt").handler("fix the bug", ctx);
	check(
		"el fallo de autenticación se informa con el error",
		notes.some((n) => n.type === "error" && /sin credenciales/.test(n.message)),
		JSON.stringify(notes),
	);
	check("el fallo de autenticación no llama al modelo", (globalThis.__improveCalls ?? []).length === 0);
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
	check("/improve-prompt llama a completeSimple una vez", callList.length === 1, `calls=${callList.length}`);
	const call = callList[0];
	check("/improve-prompt pasa el modelo actual", call?.model?.id === "claude");
	check(
		"/improve-prompt envía un prompt del sistema",
		typeof call?.context?.systemPrompt === "string" && call.context.systemPrompt.length > 0,
	);
	check("/improve-prompt no envía herramientas", !("tools" in (call?.context ?? {})));
	check(
		"/improve-prompt envía solo el borrador como el (único) mensaje de usuario",
		call?.context?.messages?.length === 1 && call.context.messages[0]?.content === "fix the bug in the parser",
	);
	check("/improve-prompt pasa la apiKey resuelta", call?.options?.apiKey === "test-key");
	check("/improve-prompt acota maxTokens", typeof call?.options?.maxTokens === "number" && call.options.maxTokens > 0);
	check(
		"/improve-prompt omite reasoning para un modelo sin reasoning",
		!("reasoning" in (call?.options ?? {})),
		JSON.stringify(call?.options),
	);
	check(
		"/improve-prompt imprime la reescritura en modo print",
		out.some((l) => l.includes("IMPROVED PROMPT")),
		JSON.stringify(out),
	);
	check(
		"el modo print NUNCA envía la reescritura (no existe confirmación interactiva)",
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
		"/improve-prompt pasa reasoning para un modelo con reasoning",
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
		"el error del modelo se informa con el mensaje",
		r.notes.some((n) => n.type === "error" && /boom/.test(n.message)),
		JSON.stringify(r.notes),
	);
	check("el error del modelo no abre overlay", r.overlays.length === 0);

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
		"la reescritura vacía se informa como advertencia",
		r.notes.some((n) => n.type === "warning" && /ninguna reescritura/i.test(n.message)),
		JSON.stringify(r.notes),
	);
	check("la reescritura vacía no abre overlay", r.overlays.length === 0);

	resetModelCalls();
	globalThis.__improveResponse = { content: [], stopReason: "aborted", role: "assistant", usage: {} };
	r = makeCtx({ mode: "tui", hasUI: true });
	await commands.get("improve-prompt").handler("q", r.ctx);
	check(
		"aborted se informa como info",
		r.notes.some((n) => n.type === "info" && /cancelado/i.test(n.message)),
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

	check("/improve-prompt abre exactamente un overlay en la TUI", overlays.length === 1);
	const comp = overlays[0]?.component;
	check("el componente overlay tiene render()", typeof comp?.render === "function");
	let lines;
	try {
		lines = comp.render(80);
	} catch (e) {
		lines = e;
	}
	check("render() del overlay devuelve líneas sin lanzar", Array.isArray(lines), String(lines));
	comp?.handleInput?.("q");
	check("el overlay se cierra con q", overlays[0]?.getClosed() === true);

	check("se pide confirmación exactamente una vez", confirmCalls.length === 1, JSON.stringify(confirmCalls));
	check(
		"al confirmar, ENVÍA la reescritura vía pi.sendUserMessage (idle -> llamada directa)",
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
		"la confirmación en medio del flujo envía como followUp (no como steer directo)",
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
	check("rechazar la confirmación no envía nada", sendCalls.length === 0, JSON.stringify(sendCalls));
	check(
		"el rechazo se informa (no enviado)",
		notes.some((n) => n.type === "info" && /no enviado/i.test(n.message)),
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
	check("el modo rpc no abre overlay de TUI (custom())", overlays.length === 0);
	check(
		"el modo rpc notifica la reescritura antes de confirmar",
		notes.some((n) => n.type === "info" && /IMPROVED PROMPT/.test(n.message)),
		JSON.stringify(notes),
	);
	check("el modo rpc igual pide confirmación", confirmCalls.length === 1);
	check("el modo rpc envía al confirmar", sendCalls.length === 1, JSON.stringify(sendCalls));
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
