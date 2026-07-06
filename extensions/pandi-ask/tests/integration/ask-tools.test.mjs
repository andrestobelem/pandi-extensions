#!/usr/bin/env node
/**
 * Prueba de integración de comportamiento estable para las tools invocables por el modelo registradas en
 * extensions/pandi-ask/index.ts: `ask_choice` y `ask_confirm`.
 *
 * Por qué existe: el asistente no puede abrir un selector TUI interactivo desde una
 * respuesta en texto plano; solo una TOOL puede hacerlo. Estas tools envuelven los helpers de diálogo de pi (`ctx.ui.select`
 * / `ctx.ui.confirm`, que funcionan en TUI y RPC) para que el modelo pueda presentar un punto de decisión
 * como un selector interactivo y recuperar la elección. Esta suite fija el contrato:
 *   - ambas tools se registran, con los parámetros esperados
 *   - ask_choice: con UI, llama a ui.select(question, options) y devuelve JSON
 *     {index (1-based), label}; al cancelar devuelve {cancelled:true}
 *   - ask_confirm: con UI, llama a ui.confirm(title, message) y devuelve {confirmed}
 *   - en modo no interactivo (sin hasUI): no abre ningún diálogo y devuelve un error en texto plano
 *   - ask_choice con options vacías: no abre ningún selector y devuelve un error
 *   - los toggles de /ask pueden elegir una respuesta recomendada inmediatamente o tras 60s
 *
 * Auto-bootstrap: hace esbuild del archivo actual extensions/pandi-ask/index.ts en un dir temp del SO
 * en tiempo de ejecución (con typebox stubbed to identity), así nunca prueba un bundle obsoleto; luego
 * ejecuta las tools registradas reales con un ctx falso cuyos ui.select/ui.confirm están mockeados.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildAsk() {
	return await buildExtension({
		name: "pi-ask-tools",
		src: path.join(REPO_ROOT, "extensions", "pandi-ask", "index.ts"),
		outName: "ask.mjs",
		stubs: { typebox: true },
		npx: "--no-install",
	});
}

function makeCtx({ mode = "tui", selectReturn, confirmReturn, selectImpl, confirmImpl } = {}) {
	const selectCalls = [];
	const confirmCalls = [];
	const notifyCalls = [];
	return {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		ui: {
			select: async (title, options, opts) => {
				selectCalls.push({ title, options, opts });
				return selectImpl ? await selectImpl(title, options, opts) : selectReturn;
			},
			confirm: async (title, message, opts) => {
				confirmCalls.push({ title, message, opts });
				return confirmImpl ? await confirmImpl(title, message, opts) : confirmReturn;
			},
			notify: (message, type) => notifyCalls.push({ message, type }),
		},
		_selectCalls: selectCalls,
		_confirmCalls: confirmCalls,
		_notifyCalls: notifyCalls,
	};
}

function makePi() {
	const tools = new Map();
	const commands = new Map();
	return {
		pi: {
			registerTool: (tool) => tools.set(tool.name, tool),
			registerCommand: (name, command) => commands.set(name, command),
		},
		tools,
		commands,
	};
}

async function loadExtension(url) {
	const extension = await loadDefault(url);
	const { pi, tools, commands } = makePi();
	extension(pi);
	return { tools, commands };
}

function expectJsonResult(label, result) {
	const text = result?.content?.[0]?.text;
	check(`${label}: result content[0].text is a string`, typeof text === "string", JSON.stringify(result));
	if (typeof text !== "string") return undefined;
	try {
		return JSON.parse(text);
	} catch (err) {
		check(`${label}: result text is valid JSON`, false, `${err?.message ?? err}: ${text}`);
		return undefined;
	}
}

async function withImmediateTimers(fn) {
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	globalThis.setTimeout = (callback, ms, ...args) => {
		queueMicrotask(() => callback(...args));
		return { ms };
	};
	globalThis.clearTimeout = () => {};
	try {
		return await fn();
	} finally {
		globalThis.setTimeout = realSetTimeout;
		globalThis.clearTimeout = realClearTimeout;
	}
}

function resolveOnAbort(opts) {
	return new Promise((resolve) => {
		if (opts?.signal?.aborted) {
			resolve(undefined);
			return;
		}
		opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
	});
}

async function scenarioRegistered(tools, commands) {
	const choice = tools.get("ask_choice");
	const confirm = tools.get("ask_confirm");
	check("ask_choice tool registered", !!choice, String(!!choice));
	check("ask_confirm tool registered", !!confirm, String(!!confirm));
	check("ask command registered", !!commands.get("ask"), String(!!commands.get("ask")));
	check("ask_choice execute is a function", typeof choice?.execute === "function");
	check("ask_confirm execute is a function", typeof confirm?.execute === "function");
	check(
		"ask_choice has question + options params",
		!!choice?.parameters?.question && "options" in (choice?.parameters ?? {}),
		JSON.stringify(Object.keys(choice?.parameters ?? {})),
	);
	check(
		"ask_choice has recommended params",
		"recommendedIndex" in (choice?.parameters ?? {}) && "recommendedLabel" in (choice?.parameters ?? {}),
		JSON.stringify(Object.keys(choice?.parameters ?? {})),
	);
	check(
		"ask_confirm has title + recommended params",
		"title" in (confirm?.parameters ?? {}) && "recommended" in (confirm?.parameters ?? {}),
		JSON.stringify(Object.keys(confirm?.parameters ?? {})),
	);
	check(
		"ask_choice description mentions options/pick",
		/opci[oó]n|elegir|elija|selector/i.test(choice?.description || ""),
		choice?.description,
	);
}

async function scenarioChoiceSelect(tools) {
	const tool = tools.get("ask_choice");
	const ctx = makeCtx({ mode: "tui", selectReturn: "Beta" });
	const result = await tool.execute(
		"c1",
		{ question: "Pick one:", options: ["Alpha", "Beta", "Gamma"] },
		undefined,
		undefined,
		ctx,
	);
	check("choice: ui.select called exactly once", ctx._selectCalls.length === 1, String(ctx._selectCalls.length));
	check("choice: ui.select got the question", ctx._selectCalls[0]?.title === "Pick one:", ctx._selectCalls[0]?.title);
	check(
		"choice: ui.select got the options",
		JSON.stringify(ctx._selectCalls[0]?.options) === JSON.stringify(["Alpha", "Beta", "Gamma"]),
		JSON.stringify(ctx._selectCalls[0]?.options),
	);
	const parsed = expectJsonResult("choice", result);
	check("choice: returns JSON with 1-based index", parsed?.index === 2, JSON.stringify(parsed));
	check("choice: returns the chosen label", parsed?.label === "Beta", JSON.stringify(parsed));
	check("choice: not cancelled", parsed?.cancelled !== true, JSON.stringify(parsed));
}

async function scenarioChoiceCancel(tools) {
	const tool = tools.get("ask_choice");
	const ctx = makeCtx({ mode: "tui", selectReturn: undefined });
	const result = await tool.execute(
		"c2",
		{ question: "Pick one:", options: ["Alpha", "Beta"] },
		undefined,
		undefined,
		ctx,
	);
	check("cancel: ui.select was called", ctx._selectCalls.length === 1, String(ctx._selectCalls.length));
	const parsed = expectJsonResult("cancel", result);
	check("cancel: returns cancelled:true", parsed?.cancelled === true, JSON.stringify(parsed));
}

async function scenarioChoiceNoUi(tools) {
	const tool = tools.get("ask_choice");
	const ctx = makeCtx({ mode: "print", selectReturn: "Alpha" });
	const result = await tool.execute(
		"c3",
		{ question: "Pick one:", options: ["Alpha", "Beta"] },
		undefined,
		undefined,
		ctx,
	);
	check("no-ui: opens no selector", ctx._selectCalls.length === 0, String(ctx._selectCalls.length));
	check(
		"no-ui: returns an error mentioning non-interactive",
		/no disponible|no interactivo|texto plano/i.test(result?.content?.[0]?.text || ""),
		result?.content?.[0]?.text,
	);
}

async function scenarioChoiceEmpty(tools) {
	const tool = tools.get("ask_choice");
	const ctx = makeCtx({ mode: "tui", selectReturn: "Alpha" });
	const result = await tool.execute("c4", { question: "Pick one:", options: [] }, undefined, undefined, ctx);
	check("empty: opens no selector", ctx._selectCalls.length === 0, String(ctx._selectCalls.length));
	check(
		"empty: returns an error",
		/no options|error/i.test(result?.content?.[0]?.text || ""),
		result?.content?.[0]?.text,
	);
}

async function scenarioRecommendedChoiceImmediate(tools, commands) {
	const tool = tools.get("ask_choice");
	const ctx = makeCtx({ mode: "tui", selectReturn: "Alpha" });
	await commands.get("ask").handler("recommended on", ctx);
	const result = await tool.execute(
		"c5",
		{ question: "Pick one:", options: ["Alpha", "Beta", "Gamma"], recommendedIndex: 2 },
		undefined,
		undefined,
		ctx,
	);
	const parsed = expectJsonResult("recommended/immediate", result);
	check("recommended/immediate: opens no selector", ctx._selectCalls.length === 0, String(ctx._selectCalls.length));
	check(
		"recommended/immediate: returns recommended label",
		parsed?.index === 2 && parsed?.label === "Beta",
		JSON.stringify(parsed),
	);
	check("recommended/immediate: marks result as recommended", parsed?.recommended === true, JSON.stringify(parsed));
}

async function scenarioRecommendedChoiceByLabel(tools, commands) {
	const tool = tools.get("ask_choice");
	const ctx = makeCtx({ mode: "tui", selectReturn: "Alpha" });
	await commands.get("ask").handler("recommended on", ctx);
	const result = await tool.execute(
		"c6",
		{ question: "Pick one:", options: ["Alpha", "Beta", "Gamma"], recommendedLabel: "Gamma" },
		undefined,
		undefined,
		ctx,
	);
	const parsed = expectJsonResult("recommended/label", result);
	check(
		"recommended/label: returns matching option",
		parsed?.index === 3 && parsed?.label === "Gamma",
		JSON.stringify(parsed),
	);
}

async function scenarioRecommendedChoiceTimeout(tools, commands) {
	const tool = tools.get("ask_choice");
	let sawTimeoutMs;
	const ctx = makeCtx({
		mode: "tui",
		selectImpl: async (_title, _options, opts) => {
			sawTimeoutMs = opts?.timeout;
			return await resolveOnAbort(opts);
		},
	});
	await commands.get("ask").handler("recommended-timeout on", ctx);
	const result = await withImmediateTimers(
		async () =>
			await tool.execute(
				"c7",
				{ question: "Pick one:", options: ["Alpha", "Beta"], recommendedIndex: 2 },
				undefined,
				undefined,
				ctx,
			),
	);
	const parsed = expectJsonResult("recommended-timeout", result);
	check("recommended-timeout: opens selector once", ctx._selectCalls.length === 1, String(ctx._selectCalls.length));
	check("recommended-timeout: passes a 60s timeout", sawTimeoutMs === 60_000, `timeout=${sawTimeoutMs}`);
	check(
		"recommended-timeout: returns recommended after timeout",
		parsed?.index === 2 && parsed?.recommended === true,
		JSON.stringify(parsed),
	);
}

async function scenarioRecommendedChoiceManualCancelStillCancels(tools, commands) {
	const tool = tools.get("ask_choice");
	const ctx = makeCtx({ mode: "tui", selectReturn: undefined });
	await commands.get("ask").handler("recommended-timeout on", ctx);
	const result = await tool.execute(
		"c8",
		{ question: "Pick one:", options: ["Alpha", "Beta"], recommendedIndex: 2 },
		undefined,
		undefined,
		ctx,
	);
	const parsed = expectJsonResult("recommended-timeout/cancel", result);
	check("recommended-timeout/cancel: returns cancelled", parsed?.cancelled === true, JSON.stringify(parsed));
}

async function scenarioConfirmTrue(tools) {
	const tool = tools.get("ask_confirm");
	const ctx = makeCtx({ mode: "tui", confirmReturn: true });
	const result = await tool.execute("k1", { title: "Proceed?", message: "This is safe." }, undefined, undefined, ctx);
	check("confirm-true: ui.confirm called once", ctx._confirmCalls.length === 1, String(ctx._confirmCalls.length));
	check(
		"confirm-true: ui.confirm got title + message",
		ctx._confirmCalls[0]?.title === "Proceed?" && ctx._confirmCalls[0]?.message === "This is safe.",
		JSON.stringify(ctx._confirmCalls[0]),
	);
	const parsed = expectJsonResult("confirm-true", result);
	check("confirm-true: returns confirmed:true", parsed?.confirmed === true, result?.content?.[0]?.text);
}

async function scenarioConfirmFalse(tools) {
	const tool = tools.get("ask_confirm");
	const ctx = makeCtx({ mode: "tui", confirmReturn: false });
	const result = await tool.execute("k2", { title: "Proceed?" }, undefined, undefined, ctx);
	const parsed = expectJsonResult("confirm-false", result);
	check("confirm-false: returns confirmed:false", parsed?.confirmed === false, result?.content?.[0]?.text);
}

async function scenarioConfirmNoUi(tools) {
	const tool = tools.get("ask_confirm");
	const ctx = makeCtx({ mode: "print", confirmReturn: true });
	const result = await tool.execute("k3", { title: "Proceed?" }, undefined, undefined, ctx);
	check("confirm no-ui: opens no dialog", ctx._confirmCalls.length === 0, String(ctx._confirmCalls.length));
	check(
		"confirm no-ui: returns an error",
		/no disponible|no interactivo|texto plano/i.test(result?.content?.[0]?.text || ""),
		result?.content?.[0]?.text,
	);
}

async function scenarioRecommendedConfirmImmediate(tools, commands) {
	const tool = tools.get("ask_confirm");
	const ctx = makeCtx({ mode: "tui", confirmReturn: true });
	await commands.get("ask").handler("recommended on", ctx);
	const result = await tool.execute("k4", { title: "Proceed?", recommended: false }, undefined, undefined, ctx);
	const parsed = expectJsonResult("confirm recommended/immediate", result);
	check(
		"confirm recommended/immediate: opens no dialog",
		ctx._confirmCalls.length === 0,
		String(ctx._confirmCalls.length),
	);
	check(
		"confirm recommended/immediate: returns recommended false",
		parsed?.confirmed === false,
		JSON.stringify(parsed),
	);
	check("confirm recommended/immediate: marks recommended", parsed?.recommended === true, JSON.stringify(parsed));
}

async function scenarioRecommendedConfirmTimeout(tools, commands) {
	const tool = tools.get("ask_confirm");
	let sawTimeoutMs;
	const ctx = makeCtx({
		mode: "tui",
		confirmImpl: async (_title, _message, opts) => {
			sawTimeoutMs = opts?.timeout;
			await resolveOnAbort(opts);
			return false;
		},
	});
	await commands.get("ask").handler("recommended-timeout on", ctx);
	const result = await withImmediateTimers(
		async () => await tool.execute("k5", { title: "Proceed?", recommended: true }, undefined, undefined, ctx),
	);
	const parsed = expectJsonResult("confirm recommended-timeout", result);
	check(
		"confirm recommended-timeout: opens dialog once",
		ctx._confirmCalls.length === 1,
		String(ctx._confirmCalls.length),
	);
	check("confirm recommended-timeout: passes a 60s timeout", sawTimeoutMs === 60_000, `timeout=${sawTimeoutMs}`);
	check("confirm recommended-timeout: returns recommended true", parsed?.confirmed === true, JSON.stringify(parsed));
}

async function scenarioAskCommandStatus(tools, commands) {
	void tools;
	const ctx = makeCtx({ mode: "tui" });
	await commands.get("ask").handler("status", ctx);
	check(
		"ask command: status reports both toggles",
		/recommended: off; recommended-timeout: off/.test(ctx._notifyCalls[0]?.message ?? ""),
		JSON.stringify(ctx._notifyCalls),
	);
}

async function main() {
	const { outDir, url } = await buildAsk();
	try {
		const { tools, commands } = await loadExtension(url);
		await scenarioRegistered(tools, commands);
		await scenarioChoiceSelect(tools);
		await scenarioChoiceCancel(tools);
		await scenarioChoiceNoUi(tools);
		await scenarioChoiceEmpty(tools);
		await scenarioAskCommandStatus(tools, commands);

		// Cada escenario de toggles carga una extensión fresca para que los toggles de sesión no filtren entre casos.
		await scenarioRecommendedChoiceImmediate(...Object.values(await loadExtension(url)));
		await scenarioRecommendedChoiceByLabel(...Object.values(await loadExtension(url)));
		await scenarioRecommendedChoiceTimeout(...Object.values(await loadExtension(url)));
		await scenarioRecommendedChoiceManualCancelStillCancels(...Object.values(await loadExtension(url)));

		await scenarioConfirmTrue(tools);
		await scenarioConfirmFalse(tools);
		await scenarioConfirmNoUi(tools);
		await scenarioRecommendedConfirmImmediate(...Object.values(await loadExtension(url)));
		await scenarioRecommendedConfirmTimeout(...Object.values(await loadExtension(url)));
	} finally {
		const fs = await import("node:fs/promises");
		await fs.rm(outDir, { recursive: true, force: true });
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
