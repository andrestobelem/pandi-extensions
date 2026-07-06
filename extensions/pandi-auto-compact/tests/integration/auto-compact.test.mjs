#!/usr/bin/env node
/**
 * Test de integración de comportamiento para pandi-auto-compact.
 *
 * Foco: la compactación disparada por cruce del umbral debe activarse UNA VEZ ante un cruce
 * genuino del umbral y NO debe volver a activarse en cada turno cuando una compactación completada no logró
 * llevar el usage de nuevo por debajo del umbral (el loop de recompactación).
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	bundle,
	createChecker,
	loadDefault,
	loadModule,
	makeBuildDir,
	sdkStub,
} from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

function requireFunction(label, value) {
	check(label, typeof value === "function", `typeof=${typeof value}`);
	return typeof value === "function" ? value : undefined;
}

function requireObject(label, value) {
	const ok = value !== null && typeof value === "object";
	check(label, ok, `typeof=${typeof value}`);
	return ok ? value : undefined;
}

function completionValues(items) {
	return (items ?? []).map((item) => item.value);
}

function expectedCompletionValues(canonicalCompletions, prefix) {
	const needle = prefix.trim().toLowerCase();
	return canonicalCompletions
		.filter((item) => !needle || item.value.toLowerCase().startsWith(needle))
		.map((item) => item.value);
}

function sameList(actual, expected) {
	return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

const DEFAULT_FAST_SUMMARY_RESPONSE = {
	role: "assistant",
	content: [{ type: "text", text: "## Goal\nResumen rápido\n\n## Next Steps\n1. Seguir" }],
	model: "summary-model",
	usage: {},
	stopReason: "stop",
	timestamp: 0,
};

const COMPAT_STUB =
	"export async function completeSimple(model, context, options) {\n" +
	"  (globalThis.__autoCompactSummaryCalls ??= []).push({ model, context, options });\n" +
	"  if (globalThis.__autoCompactSummaryThrows) throw new Error(globalThis.__autoCompactSummaryThrows);\n" +
	"  const r = globalThis.__autoCompactSummaryResponse;\n" +
	`  return r ?? ${JSON.stringify(DEFAULT_FAST_SUMMARY_RESPONSE)};\n` +
	"}\n";

function resetFastSummaryGlobals() {
	delete globalThis.__autoCompactSummaryCalls;
	delete globalThis.__autoCompactSummaryResponse;
	delete globalThis.__autoCompactSummaryThrows;
}

async function build() {
	const { outDir, aliases } = await makeBuildDir("pandi-auto-compact-integration", {
		// snapshots.ts importa CONFIG_DIR_NAME desde el SDK, y el fast-summary usa helpers de compaction.
		sdk: (dir) => sdkStub(dir),
	});
	await fs.appendFile(
		aliases["@earendil-works/pi-coding-agent"],
		"export function convertToLlm(messages) { return messages; }\n" +
			"export function serializeConversation(messages) { return messages.map((m) => { const c = Array.isArray(m.content) ? m.content.map((b) => b.text ?? JSON.stringify(b)).join(' ') : String(m.content ?? ''); return '[' + m.role + ']: ' + c; }).join('\\n'); }\n",
	);
	const compatFile = path.join(outDir, "stub-ai-compat.mjs");
	await fs.writeFile(compatFile, COMPAT_STUB, "utf8");
	aliases["@earendil-works/pi-ai/compat"] = compatFile;
	return await bundle({
		src: path.join(REPO_ROOT, "extensions", "pandi-auto-compact", "index.ts"),
		outDir,
		outName: "ac.mjs",
		aliases,
		npx: "--no-install",
	});
}

async function loadExtension(url) {
	const extension = await loadDefault(url);
	const handlers = new Map();
	const commands = new Map();
	const pi = {
		on: (event, fn) => handlers.set(event, fn),
		registerCommand: (name, opts) => commands.set(name, opts),
	};
	extension(pi);
	return { handlers, commands };
}

// Construye un mensaje de tool-result con un bloque de texto del tamaño dado (más extras opcionales).
function toolResult(id, size, { isError = false, toolName = "read", extra = [] } = {}) {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName,
		isError,
		timestamp: 1,
		content: [{ type: "text", text: "X".repeat(size) }, ...extra],
	};
}

/**
 * ExtensionContext falso. `compact` incrementa un contador y, al completarse,
 * aplica `reduceTo` (si está definido) al usage reportado antes de invocar onComplete,
 * modelando una compactación que puede o no llevar el usage por debajo del umbral.
 *
 * Las llamadas a `setStatus` se registran para poder afirmar el comportamiento de la barra del footer;
 * `theme.fg` es una identidad para que las aserciones vean el texto crudo de la barra.
 */
function makeEnv({ hasUI = true, sessionId = "s1", cwd, model, modelRegistry } = {}) {
	const notes = [];
	const statuses = []; // { key, text } en orden de llamada; text undefined significa limpio
	// Diálogos interactivos guionados: los tests empujan respuestas; las llamadas se registran.
	const selectCalls = [];
	const inputCalls = [];
	const selectResponses = [];
	const inputResponses = [];
	const state = { percent: 0, compactCount: 0, reduceTo: null, failCompaction: false };
	// Workspace temporal por env + session manager para que la ruta de instantánea quede aislada.
	const workdir = cwd ?? mkdtempSync(path.join(os.tmpdir(), "ac-snap-"));
	const ctx = {
		hasUI,
		cwd: workdir,
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			notify: (m, l) => notes.push({ m, l }),
			setStatus: (key, text) => statuses.push({ key, text }),
			theme: { fg: (_color, text) => text },
			select: async (title, options) => {
				selectCalls.push({ title, options });
				return selectResponses.shift();
			},
			input: async (title, placeholder) => {
				inputCalls.push({ title, placeholder });
				return inputResponses.shift();
			},
		},
		model,
		modelRegistry,
		getContextUsage: () => ({ percent: state.percent }),
		compact: ({ onComplete, onError }) => {
			state.compactCount += 1;
			queueMicrotask(() => {
				// Una compactación fallida (error de LLM/network) invoca onError SIN
				// reducir el usage, modelando una falla transitoria que deja el
				// contexto intacto y todavía por encima del umbral.
				if (state.failCompaction) {
					onError?.(new Error("compaction boom"));
					return;
				}
				if (state.reduceTo !== null) state.percent = state.reduceTo;
				onComplete?.();
			});
		},
	};
	return { ctx, notes, statuses, state, selectCalls, inputCalls, selectResponses, inputResponses, workdir };
}

// Helpers de instantáneas de compactación recuperable ----------------------------------
// Los eventos session_before_compact / session_compact disparan la escritura de instantáneas.
async function fireBeforeCompact(handlers, ctx, { branchEntries = [], reason = "threshold", willRetry = false } = {}) {
	return handlers.get("session_before_compact")?.({ branchEntries, reason, willRetry }, ctx);
}

async function fireSessionCompact(handlers, ctx, { summary = "" } = {}) {
	return handlers.get("session_compact")?.({ compactionEntry: { summary } }, ctx);
}

function makeSummaryRegistry({ models, authOk = true, authError = "no auth" }) {
	const byKey = new Map(models.map((m) => [`${m.provider}/${m.id}`, m]));
	const authCalls = [];
	return {
		authCalls,
		registry: {
			find: (provider, id) => byKey.get(`${provider}/${id}`),
			getApiKeyAndHeaders: async (model) => {
				authCalls.push(model);
				return authOk
					? { ok: true, apiKey: "summary-key", headers: { "x-test": "1" }, env: { TEST_ENV: "1" } }
					: { ok: false, error: authError };
			},
		},
	};
}

function compactPreparation(overrides = {}) {
	return {
		firstKeptEntryId: "keep-1",
		messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "Necesito mejorar auto-compact" }] }],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 12345,
		previousSummary: "Resumen anterior importante",
		fileOps: {
			read: new Set(["extensions/pandi-auto-compact/README.md", "extensions/pandi-auto-compact/index.ts"]),
			written: new Set(["extensions/pandi-auto-compact/fast-summary.ts"]),
			edited: new Set(["extensions/pandi-auto-compact/index.ts"]),
		},
		settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		...overrides,
	};
}

function beforeCompactEvent(overrides = {}) {
	return {
		branchEntries: [],
		reason: "threshold",
		willRetry: false,
		signal: new AbortController().signal,
		preparation: compactPreparation(),
		...overrides,
	};
}

// El directorio de instantáneas por sesión en el que escribe esta extensión.
function snapDir(env, sessionId = "s1") {
	return path.join(env.workdir, ".pi", "compaction-snapshots", sessionId);
}
function snapFiles(env, sessionId = "s1") {
	const dir = snapDir(env, sessionId);
	return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")) : [];
}

// El texto más reciente del estado del footer (o undefined cuando se limpió por última vez).
const lastStatus = (env) => (env.statuses.length ? env.statuses[env.statuses.length - 1].text : undefined);

const tick = () => new Promise((r) => setTimeout(r, 0));

async function fireAgentEnd(handlers, ctx) {
	await handlers.get("agent_end")?.(null, ctx);
	await tick(); // deja correr el onComplete de compactación encolado
}

async function fireTurnEnd(handlers, ctx) {
	await handlers.get("turn_end")?.(null, ctx);
}

async function stuckAboveThresholdDoesNotLoop(url) {
	const { handlers } = await loadExtension(url);
	const env = makeEnv();
	// La compactación nunca baja el usage por debajo del umbral predeterminado de 35%.
	env.state.percent = 60;
	env.state.reduceTo = 60;

	await fireAgentEnd(handlers, env.ctx); // cruce genuino -> compactación #1
	await fireAgentEnd(handlers, env.ctx); // sigue en 60% -> NO debe recompartar
	await fireAgentEnd(handlers, env.ctx); // sigue en 60% -> NO debe recompartar

	check(
		"loop: compaction fires exactly once while usage stays above threshold",
		env.state.compactCount === 1,
		`compactCount=${env.state.compactCount}`,
	);
}

// Una compactación FALLIDA (onError) debe rearmar el disparo por cruce para que un turno
// posterior por encima del umbral reintente — si no, una sola falla transitoria deshabilita
// la auto-compactación en silencio por el resto de la sesión (el bug de "onError nunca
// rearma"). Distinto de stuckAboveThresholdDoesNotLoop, donde la compactación
// TIENE ÉXITO pero no puede reducir el usage (ahí NO debemos entrar en loop).
async function failedCompactionReArmsAndRetriggers(url) {
	const { handlers } = await loadExtension(url);
	const env = makeEnv();
	env.state.percent = 60; // por encima del umbral predeterminado de 35%
	env.state.failCompaction = true;

	await fireAgentEnd(handlers, env.ctx); // cruce -> se intenta la compactación #1, falla
	await fireAgentEnd(handlers, env.ctx); // sigue en 60% tras la falla -> DEBE reintentar
	check(
		"failure: a failed compaction re-arms so the next above-threshold turn retries",
		env.state.compactCount === 2,
		`compactCount=${env.state.compactCount}`,
	);
}

async function genuineRecrossRetriggers(url) {
	const { handlers } = await loadExtension(url);
	const env = makeEnv();
	// La compactación tiene éxito: lleva el usage a 20% (por debajo del umbral).
	env.state.percent = 60;
	env.state.reduceTo = 20;

	await fireAgentEnd(handlers, env.ctx); // cruce -> compactación #1, ahora en 20%
	await fireAgentEnd(handlers, env.ctx); // 20% < 35% -> sin compactación
	env.state.percent = 60; // nuevo aumento genuino por encima del umbral
	env.state.reduceTo = 20;
	await fireAgentEnd(handlers, env.ctx); // vuelve a cruzar -> compactación #2

	check(
		"recross: a genuine new threshold crossing re-triggers compaction",
		env.state.compactCount === 2,
		`compactCount=${env.state.compactCount}`,
	);
}

async function belowThresholdNeverCompacts(url) {
	const { handlers } = await loadExtension(url);
	const env = makeEnv();
	env.state.percent = 20; // nunca cruza 35%
	await fireAgentEnd(handlers, env.ctx);
	await fireAgentEnd(handlers, env.ctx);
	check(
		"below: no compaction while under threshold",
		env.state.compactCount === 0,
		`compactCount=${env.state.compactCount}`,
	);
}

async function codexDefaultThresholdIsFifty(url) {
	const { handlers } = await loadExtension(url);
	const env = makeEnv({ model: { provider: "openai-codex", id: "gpt-5.5" } });
	env.state.percent = 40; // por encima del 35% de Claude, por debajo del 50% de Codex
	await fireAgentEnd(handlers, env.ctx);
	check(
		"default: Codex does not compact below 50%",
		env.state.compactCount === 0,
		`compactCount=${env.state.compactCount}`,
	);
	env.state.percent = 50;
	await fireAgentEnd(handlers, env.ctx);
	check("default: Codex compacts at 50%", env.state.compactCount === 1, `compactCount=${env.state.compactCount}`);
}

async function claudeDefaultThresholdRemainsThirtyFive(url) {
	const { handlers } = await loadExtension(url);
	const env = makeEnv({ model: { provider: "anthropic", id: "claude-sonnet-4-5" } });
	env.state.percent = 40; // por encima del predeterminado de 35% de Claude
	await fireAgentEnd(handlers, env.ctx);
	check(
		"default: Claude still compacts at 35%",
		env.state.compactCount === 1,
		`compactCount=${env.state.compactCount}`,
	);
}

// Cobertura pura a nivel unitario para parseThreshold (export nombrado). Importa el
// módulo bundleado directamente; no instancia la extensión.
async function parseThresholdEdgeCases(url) {
	const mod = await loadModule(url);
	const parseThreshold = requireFunction("parseThreshold: exported as a function", mod.parseThreshold);
	if (!parseThreshold) return;

	const cases = [
		["50", 50],
		["50%", 50],
		["0", undefined], // <= 0 rechazado
		["100", undefined], // >= 100 rechazado
		["", undefined],
		[undefined, undefined],
		["abc", undefined], // NaN rechazado
		[" 75 ", 75], // con trim aplicado
	];
	for (const [input, expected] of cases) {
		const actual = parseThreshold(input);
		check(
			`parseThreshold(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`,
			actual === expected,
			`got ${JSON.stringify(actual)}`,
		);
	}
}

// Cobertura pura para renderContextBar (export nombrado): relleno, etiqueta y `level`.
async function renderContextBarCases(url) {
	const mod = await loadModule(url);
	const renderContextBar = requireFunction("renderContextBar: exported as a function", mod.renderContextBar);
	if (!renderContextBar) return;

	const unknown = renderContextBar({ percent: null, thresholdPercent: 30 });
	check("renderContextBar: null usage renders nothing", unknown === null, `got ${JSON.stringify(unknown)}`);

	const low = renderContextBar({ percent: 6, thresholdPercent: 30, width: 8 });
	check(
		"renderContextBar: low usage is idle and labels usage/threshold",
		low?.level === "idle" && low?.text.includes("6%/30%"),
		`got ${JSON.stringify(low)}`,
	);

	const near = renderContextBar({ percent: 24, thresholdPercent: 30, width: 8 });
	check("renderContextBar: 0.8 of threshold is near", near?.level === "near", `got ${JSON.stringify(near)}`);

	const over = renderContextBar({ percent: 60, thresholdPercent: 30, width: 8 });
	// El fill se limita a completo (8 glifos llenos, 0 vacíos) y level es over.
	check(
		"renderContextBar: usage above threshold clamps to a full bar and over level",
		over?.level === "over" &&
			over?.text.includes("60%/30%") &&
			(over?.text.match(/\u25B0/g) || []).length === 8 &&
			!over?.text.includes("\u25B1"),
		`got ${JSON.stringify(over)}`,
	);

	const busy = renderContextBar({ percent: 10, thresholdPercent: 30, compacting: true });
	check(
		"renderContextBar: compacting overrides usage",
		busy?.level === "compacting" && busy?.text.includes("compacting"),
		`got ${JSON.stringify(busy)}`,
	);
}

async function parseBarSettingCases(url) {
	const mod = await loadModule(url);
	const parseBarSetting = requireFunction("parseBarSetting: exported as a function", mod.parseBarSetting);
	if (!parseBarSetting) return;
	const cases = [
		["on", true],
		["ON", true],
		[" 1 ", true],
		["off", false],
		["0", false],
		["hide", false],
		[undefined, undefined],
		["maybe", undefined],
	];
	for (const [input, expected] of cases) {
		const actual = parseBarSetting(input);
		check(
			`parseBarSetting(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`,
			actual === expected,
			`got ${JSON.stringify(actual)}`,
		);
	}
}

// Integración: la barra del footer refleja el usage en un turno normal, marca el
// estado compacting y puede apagarse/encenderse vía el comando.
async function barReflectsUsageBelowThreshold(url) {
	const { handlers } = await loadExtension(url);
	const env = makeEnv();
	env.state.percent = 15; // por debajo del umbral predeterminado de 35%
	await fireTurnEnd(handlers, env.ctx);
	const text = lastStatus(env);
	check(
		"bar: shows usage/threshold label on a normal turn",
		typeof text === "string" && text.includes("15%/35%"),
		`got ${JSON.stringify(text)}`,
	);
	check(
		"bar: renders filled/empty glyphs",
		typeof text === "string" && /[\u25B0\u25B1]/.test(text),
		`got ${JSON.stringify(text)}`,
	);
}

async function barShowsCompactingState(url) {
	const { handlers } = await loadExtension(url);
	const env = makeEnv();
	env.state.percent = 60; // cruza el umbral -> compactación
	env.state.reduceTo = 20;
	await fireAgentEnd(handlers, env.ctx);
	const sawCompacting = env.statuses.some((s) => typeof s.text === "string" && s.text.includes("compacting"));
	check(
		"bar: surfaces a compacting state while compaction runs",
		sawCompacting,
		`statuses=${JSON.stringify(env.statuses.map((s) => s.text))}`,
	);
}

async function barToggleClearsAndRestores(url) {
	const { handlers, commands } = await loadExtension(url);
	const env = makeEnv();
	const run = (args) => commands.get("auto-compact").handler(args, env.ctx);
	env.state.percent = 15;
	await fireTurnEnd(handlers, env.ctx);
	check(
		"bar toggle: visible before turning off",
		typeof lastStatus(env) === "string",
		`got ${JSON.stringify(lastStatus(env))}`,
	);
	await run("bar off");
	check(
		"bar toggle: cleared when turned off",
		lastStatus(env) === undefined,
		`got ${JSON.stringify(lastStatus(env))}`,
	);
	await run("bar on");
	check(
		"bar toggle: restored when turned on",
		typeof lastStatus(env) === "string" && lastStatus(env).includes("15%/35%"),
		`got ${JSON.stringify(lastStatus(env))}`,
	);
}

async function barClearedWhenDisabled(url) {
	const { handlers, commands } = await loadExtension(url);
	const env = makeEnv();
	const run = (args) => commands.get("auto-compact").handler(args, env.ctx);
	env.state.percent = 15;
	await fireTurnEnd(handlers, env.ctx);
	await run("off");
	check(
		"bar: cleared when auto-compaction is disabled",
		lastStatus(env) === undefined,
		`got ${JSON.stringify(lastStatus(env))}`,
	);
}

// ---------------------------------------------------------------------------
// Autocompletado de argumentos: tipear `/auto-compact <prefix>` ofrece opciones.
// ---------------------------------------------------------------------------
// Pinea el contrato del threshold predeterminado: la constante exportada, la lista derivada
// de presets (que debe contener el predeterminado) y un único marcador "(predeterminado)" sobre él.
async function defaultThresholdContract(url) {
	const mod = await loadModule(url);
	check(
		"default: DEFAULT_THRESHOLD_PERCENT is 35",
		mod.DEFAULT_THRESHOLD_PERCENT === 35,
		`got ${mod.DEFAULT_THRESHOLD_PERCENT}`,
	);
	check(
		"default: CODEX_DEFAULT_THRESHOLD_PERCENT is 50",
		mod.CODEX_DEFAULT_THRESHOLD_PERCENT === 50,
		`got ${mod.CODEX_DEFAULT_THRESHOLD_PERCENT}`,
	);
	check(
		"default: THRESHOLD_OPTIONS includes the default preset",
		Array.isArray(mod.THRESHOLD_OPTIONS) && mod.THRESHOLD_OPTIONS.includes("35"),
		`got ${JSON.stringify(mod.THRESHOLD_OPTIONS)}`,
	);
	const markers = (mod.ARG_COMPLETIONS ?? []).filter(
		(i) => typeof i.description === "string" && i.description.includes("(predeterminado)"),
	);
	check(
		"default: exactly the default preset is marked (default)",
		markers.length === 1 && markers[0]?.value === "35",
		`got ${JSON.stringify(markers)}`,
	);
}

async function argumentCompletions(url) {
	const mod = await loadModule(url);
	const canonicalCompletions = Array.isArray(mod.ARG_COMPLETIONS) ? mod.ARG_COMPLETIONS : [];
	check(
		"autocomplete: ARG_COMPLETIONS is exported as the canonical completion table",
		canonicalCompletions.length > 0,
		`got ${JSON.stringify(mod.ARG_COMPLETIONS)}`,
	);

	const { commands } = await loadExtension(url);
	const cmd = commands.get("auto-compact");
	const getArgumentCompletions = requireFunction(
		"autocomplete: getArgumentCompletions is provided",
		cmd?.getArgumentCompletions,
	);
	if (!getArgumentCompletions || canonicalCompletions.length === 0) return;

	const checkPrefix = async (prefix, label) => {
		const actual = completionValues((await getArgumentCompletions(prefix)) ?? []);
		const expected = expectedCompletionValues(canonicalCompletions, prefix);
		check(label, sameList(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
		return actual;
	};

	const values = await checkPrefix("", "autocomplete: empty prefix matches ARG_COMPLETIONS exactly");
	check(
		"autocomplete: every canonical item has a string value and label",
		canonicalCompletions.every((i) => typeof i.value === "string" && typeof i.label === "string"),
	);
	check(
		"autocomplete: empty prefix offers at least one percent preset",
		values.some((value) => /^\d+$/.test(value)),
		`got ${JSON.stringify(values)}`,
	);

	await checkPrefix("bar", "autocomplete: 'bar' prefix matches ARG_COMPLETIONS");
	await checkPrefix("summary", "autocomplete: 'summary' prefix matches ARG_COMPLETIONS");
	await checkPrefix("of", "autocomplete: 'of' prefix matches ARG_COMPLETIONS");

	const none = await getArgumentCompletions("zzz");
	check(
		"autocomplete: an unknown prefix returns null (no spurious matches)",
		none === null && expectedCompletionValues(canonicalCompletions, "zzz").length === 0,
		`got ${JSON.stringify(none)}`,
	);
}

// ---------------------------------------------------------------------------
// Menú interactivo: un `/auto-compact` sin argumentos en una sesión con UI abre un
// select para elegir un parámetro; las opciones mapean sobre las acciones existentes.
// ---------------------------------------------------------------------------
async function bareCommandOpensMenuAndDisables(url) {
	const { handlers, commands } = await loadExtension(url);
	const env = makeEnv();
	env.state.percent = 15;
	await fireTurnEnd(handlers, env.ctx); // barra visible
	check("menu: bar visible before opening menu", typeof lastStatus(env) === "string");

	env.selectResponses.push("off — desactivar la auto-compactación");
	await commands.get("auto-compact").handler("", env.ctx);
	check(
		"menu: a bare command opens exactly one select",
		env.selectCalls.length === 1,
		`calls=${env.selectCalls.length}`,
	);
	check(
		"menu: choosing Disable turns auto-compaction off (footer bar cleared)",
		lastStatus(env) === undefined,
		`got ${JSON.stringify(lastStatus(env))}`,
	);
}

async function menuThresholdPresetSetsThreshold(url) {
	const { commands } = await loadExtension(url);
	const env = makeEnv();
	env.selectResponses.push("threshold — configurar el % de umbral de compactación");
	env.selectResponses.push("50");
	await commands.get("auto-compact").handler("", env.ctx);
	check(
		"menu: threshold choice opens a second select for the value",
		env.selectCalls.length === 2,
		`calls=${env.selectCalls.length}`,
	);
	check(
		"menu: a preset threshold is applied (notified)",
		env.notes.some((n) => typeof n.m === "string" && n.m.includes("50%")),
		`notes=${JSON.stringify(env.notes.map((n) => n.m))}`,
	);
}

async function menuThresholdCustomUsesInput(url) {
	const { commands } = await loadExtension(url);
	const env = makeEnv();
	env.selectResponses.push("threshold — configurar el % de umbral de compactación");
	env.selectResponses.push("personalizado\u2026");
	env.inputResponses.push("35");
	await commands.get("auto-compact").handler("", env.ctx);
	check(
		"menu: custom threshold prompts a text input",
		env.inputCalls.length === 1,
		`inputCalls=${env.inputCalls.length}`,
	);
	check(
		"menu: the custom threshold value is applied",
		env.notes.some((n) => typeof n.m === "string" && n.m.includes("35%")),
		`notes=${JSON.stringify(env.notes.map((n) => n.m))}`,
	);
}

async function bareCommandWithoutUiNeverOpensMenu(url) {
	const { commands } = await loadExtension(url);
	const env = makeEnv({ hasUI: false });
	await commands.get("auto-compact").handler("", env.ctx);
	check("menu: a non-UI session never opens a menu", env.selectCalls.length === 0, `calls=${env.selectCalls.length}`);
}

async function bareCommandWithUiButNoSelectFallsBackToStatus(url) {
	const { commands } = await loadExtension(url);
	const env = makeEnv();
	env.ctx.ui.select = undefined;
	let threw = false;
	try {
		await commands.get("auto-compact").handler("", env.ctx);
	} catch {
		threw = true;
	}
	check("menu: UI without select does not throw", threw === false, "handler threw");
	check(
		"menu: UI without select falls back to status",
		env.notes.some((n) => typeof n.m === "string" && n.m.includes("La auto-compactación de contexto está")),
		`notes=${JSON.stringify(env.notes.map((n) => n.m))}`,
	);
}

async function menuCustomThresholdWithoutInputFallsBackToStatus(url) {
	const { commands } = await loadExtension(url);
	const env = makeEnv();
	env.selectResponses.push("threshold — configurar el % de umbral de compactación");
	env.selectResponses.push("personalizado\u2026");
	env.ctx.ui.input = undefined;
	let threw = false;
	try {
		await commands.get("auto-compact").handler("", env.ctx);
	} catch {
		threw = true;
	}
	check("menu: custom threshold without input does not throw", threw === false, "handler threw");
	check(
		"menu: custom threshold without input falls back to status",
		env.notes.some((n) => typeof n.m === "string" && n.m.includes("La auto-compactación de contexto está")) &&
			env.inputCalls.length === 0,
		`notes=${JSON.stringify(env.notes.map((n) => n.m))}; inputCalls=${env.inputCalls.length}`,
	);
}

// ---------------------------------------------------------------------------
// Compactación recuperable: las instantáneas preservan las entradas sin procesar ANTES de que el resumen con pérdida
// las reemplace, así que la compactación es recuperable en vez de destructiva.
// ---------------------------------------------------------------------------
async function snapshotWritesRawEntries(url) {
	const { handlers } = await loadExtension(url);
	const env = makeEnv();
	const entries = [
		{ type: "message", id: "a", message: { role: "user", content: "hello raw" } },
		{ type: "message", id: "b", message: { role: "assistant", content: "world raw" } },
	];
	await fireBeforeCompact(handlers, env.ctx, { branchEntries: entries, reason: "threshold" });
	const files = snapFiles(env);
	check("snapshot: a JSON snapshot is written on session_before_compact", files.length === 1, `files=${files.length}`);
	if (files.length !== 1) return;
	const snap = JSON.parse(readFileSync(path.join(snapDir(env), files[0]), "utf8"));
	check(
		"snapshot: preserves every raw entry + metadata",
		snap.entryCount === 2 &&
			Array.isArray(snap.entries) &&
			snap.entries.length === 2 &&
			snap.entries[0].id === "a" &&
			snap.reason === "threshold" &&
			snap.version === 1,
		`snap=${JSON.stringify(snap).slice(0, 160)}`,
	);
	check(
		"snapshot: raw is captured before any summary exists",
		snap.summary === undefined,
		`summary=${JSON.stringify(snap.summary)}`,
	);
}

async function snapshotPatchesSummary(url) {
	const { handlers } = await loadExtension(url);
	const env = makeEnv();
	await fireBeforeCompact(handlers, env.ctx, { branchEntries: [{ type: "message", id: "x" }] });
	await fireSessionCompact(handlers, env.ctx, { summary: "a lossy summary of x" });
	const files = snapFiles(env);
	if (files.length !== 1) {
		check("snapshot: single file to patch", false, `files=${files.length}`);
		return;
	}
	const snap = JSON.parse(readFileSync(path.join(snapDir(env), files[0]), "utf8"));
	check(
		"snapshot: session_compact patches in the produced summary (raw + summary pair)",
		snap.summary === "a lossy summary of x" && snap.entries[0].id === "x",
		`snap=${JSON.stringify(snap).slice(0, 160)}`,
	);
}

async function snapshotDisabledWritesNothing(url) {
	const { handlers, commands } = await loadExtension(url);
	const env = makeEnv();
	await commands.get("auto-compact").handler("snapshot off", env.ctx);
	await fireBeforeCompact(handlers, env.ctx, { branchEntries: [{ type: "message", id: "z" }] });
	check("snapshot: disabled -> no file written", snapFiles(env).length === 0, `files=${snapFiles(env).length}`);
}

async function snapshotIsFailSafe(url) {
	const { handlers } = await loadExtension(url);
	const env = makeEnv();
	// Hace que la resolución del id de sesión arroje para que falle toda la ruta de escritura.
	env.ctx.sessionManager = {
		getSessionId: () => {
			throw new Error("boom");
		},
	};
	let threw = false;
	let result;
	try {
		result = await fireBeforeCompact(handlers, env.ctx, { branchEntries: [{ id: "q" }] });
	} catch {
		threw = true;
	}
	check("snapshot: a write failure never throws out of the hook", !threw);
	check(
		"snapshot: the hook never cancels compaction (returns falsy)",
		result?.cancel !== true,
		`result=${JSON.stringify(result)}`,
	);
	check(
		"snapshot: a failure surfaces a warning",
		env.notes.some((n) => n.l === "warning" && /instantánea/i.test(n.m)),
		`notes=${JSON.stringify(env.notes)}`,
	);
}

async function snapshotRetentionPrunes(url) {
	const prev = process.env.PI_AUTO_COMPACT_SNAPSHOT_KEEP;
	process.env.PI_AUTO_COMPACT_SNAPSHOT_KEEP = "2";
	try {
		const { handlers } = await loadExtension(url);
		const env = makeEnv();
		for (let i = 0; i < 4; i++) {
			await fireBeforeCompact(handlers, env.ctx, { branchEntries: [{ id: `e${i}` }] });
			await new Promise((r) => setTimeout(r, 3)); // ms ISO distintos -> nombres de archivo distintos
		}
		check(
			"snapshot: retention prunes to the newest keep=2",
			snapFiles(env).length === 2,
			`files=${snapFiles(env).length}`,
		);
	} finally {
		if (prev === undefined) delete process.env.PI_AUTO_COMPACT_SNAPSHOT_KEEP;
		else process.env.PI_AUTO_COMPACT_SNAPSHOT_KEEP = prev;
	}
}

// Cobertura pura unitaria para los helpers de instantáneas exportados.
async function snapshotPureHelpers(url) {
	const mod = await loadModule(url);
	check(
		"parseSnapshotSetting: shares the on/off grammar",
		mod.parseSnapshotSetting("on") === true &&
			mod.parseSnapshotSetting("off") === false &&
			mod.parseSnapshotSetting("maybe") === undefined,
	);
	const keepCases = [
		["20", 20],
		["1", 1],
		["0", undefined],
		["-5", undefined],
		["1.5", undefined],
		["", undefined],
		[undefined, undefined],
	];
	for (const [input, expected] of keepCases) {
		check(
			`parseSnapshotKeep(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`,
			mod.parseSnapshotKeep(input) === expected,
		);
	}
	const base = path.join("/tmp/proj", ".pi", "compaction-snapshots");
	const dir = mod.snapshotDirFor("/tmp/proj", "sess/../bad id");
	const seg = path.basename(dir);
	check(
		"snapshotDirFor: collapses path separators/spaces into one safe segment under .pi",
		dir.startsWith(base) && !seg.includes("/") && !seg.includes(" ") && seg !== ".." && seg !== ".",
		`dir=${dir}`,
	);
	check(
		"snapshotDirFor: an all-dots session id (traversal) falls back to a safe segment",
		path.basename(mod.snapshotDirFor("/tmp/proj", "..")) === "session" &&
			path.basename(mod.snapshotDirFor("/tmp/proj", ".")) === "session",
		`dotdot=${mod.snapshotDirFor("/tmp/proj", "..")}`,
	);
	const name = mod.snapshotFileName("2026-06-28T10:04:04.932Z", "threshold");
	check(
		"snapshotFileName: timestamp-prefixed, safe, .json",
		name.endsWith("-threshold.json") && !name.includes(":"),
		`name=${name}`,
	);
	const snap = mod.buildSnapshot({
		sessionId: "s",
		createdAt: "t",
		reason: "manual",
		willRetry: false,
		entries: [{ id: 1 }, { id: 2 }],
	});
	check(
		"buildSnapshot: version 1, entryCount matches, summary absent",
		snap.version === 1 && snap.entryCount === 2 && snap.summary === undefined,
		`snap=${JSON.stringify(snap)}`,
	);
	// Los nombres se ordenan cronológicamente; keep=2 poda los 3 más antiguos de 5.
	const names = ["5.json", "1.json", "3.json", "2.json", "4.json", "notes.txt"];
	const pruned = mod.selectSnapshotsToPrune(names, 2);
	check(
		"selectSnapshotsToPrune: returns the oldest beyond keep, ignores non-json",
		JSON.stringify(pruned) === JSON.stringify(["1.json", "2.json", "3.json"]),
		`pruned=${JSON.stringify(pruned)}`,
	);
	check("selectSnapshotsToPrune: keep=0 prunes all json", mod.selectSnapshotsToPrune(names, 0).length === 5);
}

// ---------------------------------------------------------------------------
// Fast-summary: custom session_before_compact con modelo rápido, prompt acotado y fallback
// a la compactación nativa de Pi si algo falla.
// ---------------------------------------------------------------------------
async function fastSummaryPureHelpers(url) {
	const mod = await loadModule(url);
	check(
		"parseFastSummarySetting: shares the on/off grammar",
		mod.parseFastSummarySetting("on") === true &&
			mod.parseFastSummarySetting("off") === false &&
			mod.parseFastSummarySetting("maybe") === undefined,
	);
	check("parseSummaryMaxTokens: accepts positive integers", mod.parseSummaryMaxTokens("4096") === 4096);
	check(
		"parseSummaryMaxTokens: rejects non-positive/invalid values",
		mod.parseSummaryMaxTokens("0") === undefined && mod.parseSummaryMaxTokens("nope") === undefined,
	);
}

async function fastSummaryProvidesCustomCompaction(url) {
	resetFastSummaryGlobals();
	const { handlers } = await loadExtension(url);
	const fast = { provider: "anthropic", id: "claude-sonnet-5", reasoning: true };
	const current = { provider: "anthropic", id: "claude-opus-4-8", reasoning: true };
	const { registry, authCalls } = makeSummaryRegistry({ models: [fast, current] });
	const env = makeEnv({ model: current, modelRegistry: registry });

	const result = await handlers.get("session_before_compact")?.(
		beforeCompactEvent({ customInstructions: "Enfatizá próximos pasos accionables" }),
		env.ctx,
	);
	const calls = globalThis.__autoCompactSummaryCalls ?? [];
	const call = calls[0];
	const prompt = call?.context?.messages?.[0]?.content ?? "";
	check("fast-summary: session_before_compact returns a custom compaction", !!result?.compaction);
	check("fast-summary: calls the LLM exactly once", calls.length === 1, `calls=${calls.length}`);
	check(
		"fast-summary: prefers Sonnet 5 over the current heavier model",
		call?.model === fast,
		`model=${call?.model?.id}`,
	);
	check("fast-summary: resolves auth for the selected summary model", authCalls[0] === fast);
	check(
		"fast-summary: passes auth headers/env and caps maxTokens",
		call?.options?.apiKey === "summary-key" &&
			call?.options?.headers?.["x-test"] === "1" &&
			call?.options?.env?.TEST_ENV === "1" &&
			call?.options?.maxTokens === 4096,
	);
	check(
		"fast-summary: uses minimal reasoning for reasoning-capable summary models",
		call?.options?.reasoning === "minimal",
		`reasoning=${call?.options?.reasoning}`,
	);
	check(
		"fast-summary: prompt preserves previous summary, custom instructions and file ops",
		prompt.includes("Resumen anterior importante") &&
			prompt.includes("Enfatizá próximos pasos accionables") &&
			prompt.includes("extensions/pandi-auto-compact/index.ts") &&
			prompt.includes("extensions/pandi-auto-compact/fast-summary.ts"),
		`prompt=${prompt.slice(0, 240)}`,
	);
	check(
		"fast-summary: compaction result preserves core fields and file details",
		result?.compaction?.summary?.includes("Resumen rápido") &&
			result.compaction.firstKeptEntryId === "keep-1" &&
			result.compaction.tokensBefore === 12345 &&
			result.compaction.details?.fastSummary?.model === "anthropic/claude-sonnet-5" &&
			result.compaction.details?.readFiles?.includes("extensions/pandi-auto-compact/README.md") &&
			result.compaction.details?.modifiedFiles?.includes("extensions/pandi-auto-compact/fast-summary.ts") &&
			result.compaction.details?.modifiedFiles?.includes("extensions/pandi-auto-compact/index.ts"),
		`result=${JSON.stringify(result?.compaction).slice(0, 260)}`,
	);
	check("fast-summary: still writes the recoverable raw snapshot first", snapFiles(env).length === 1);
}

async function fastSummaryPrefersCodex55ForCodexSessions(url) {
	resetFastSummaryGlobals();
	const { handlers } = await loadExtension(url);
	const fast = { provider: "openai-codex", id: "gpt-5.5", reasoning: true };
	const current = { provider: "openai-codex", id: "gpt-5.4", reasoning: true };
	const { registry } = makeSummaryRegistry({ models: [fast, current] });
	const env = makeEnv({ model: current, modelRegistry: registry });
	await handlers.get("session_before_compact")?.(beforeCompactEvent(), env.ctx);
	const call = (globalThis.__autoCompactSummaryCalls ?? [])[0];
	check("fast-summary: Codex sessions prefer GPT 5.5", call?.model === fast, `model=${call?.model?.id}`);
}

async function fastSummaryFallsBackWhenAuthFails(url) {
	resetFastSummaryGlobals();
	const { handlers } = await loadExtension(url);
	const fast = { provider: "anthropic", id: "claude-sonnet-5", reasoning: true };
	const { registry, authCalls } = makeSummaryRegistry({ models: [fast], authOk: false, authError: "missing key" });
	const env = makeEnv({ model: fast, modelRegistry: registry });
	const result = await handlers.get("session_before_compact")?.(beforeCompactEvent(), env.ctx);
	check(
		"fast-summary: auth failure falls back to native compaction",
		!result?.compaction,
		`result=${JSON.stringify(result)}`,
	);
	check(
		"fast-summary: auth failure does not call completeSimple",
		(globalThis.__autoCompactSummaryCalls ?? []).length === 0,
	);
	check("fast-summary: tried auth before falling back", authCalls.length > 0);
}

async function fastSummaryCommandToggle(url) {
	resetFastSummaryGlobals();
	const { handlers, commands } = await loadExtension(url);
	const fast = { provider: "anthropic", id: "claude-sonnet-5", reasoning: false };
	const { registry } = makeSummaryRegistry({ models: [fast] });
	const env = makeEnv({ model: fast, modelRegistry: registry });
	await commands.get("auto-compact").handler("summary off", env.ctx);
	let result = await handlers.get("session_before_compact")?.(beforeCompactEvent(), env.ctx);
	check("fast-summary command: summary off disables custom compaction", !result?.compaction);
	await commands.get("auto-compact").handler("summary on", env.ctx);
	result = await handlers.get("session_before_compact")?.(beforeCompactEvent(), env.ctx);
	check("fast-summary command: summary on re-enables custom compaction", !!result?.compaction);
}

// ---------------------------------------------------------------------------
// Limpieza de tool-result (research §3b): una palanca más barata, EFÍMERA y no destructiva
// que compactar. clearOldToolResults debe elidir texto VIEJO y grande de tool-result mientras
// conserva resultados recientes + con error, nunca muta inputs y es idempotente.
// ---------------------------------------------------------------------------
async function clearElidesOldLargeResults(url) {
	const mod = await loadModule(url);
	const clear = mod.clearOldToolResults;
	const opts = { keepRecent: 1, minChars: 500, headChars: 50, tailChars: 50 };
	const messages = [
		{ role: "user", content: "go" },
		toolResult("a", 5000),
		{ role: "assistant", content: [{ type: "text", text: "thinking" }] },
		toolResult("b", 300), // reciente (conservado por keepRecent:1)
	];
	const out = clear(messages, opts);
	check("clear: returns a new array when an old large result is elided", Array.isArray(out) && out !== messages);
	if (!Array.isArray(out)) return;
	const clearedText = out[1].content[0].text;
	check(
		"clear: old large result text is elided to head+marker+tail (much smaller)",
		clearedText.length < 400 && clearedText.length < 5000 / 4 && clearedText.includes(mod.CLEARED_SENTINEL),
		`len=${clearedText.length}`,
	);
	check(
		"clear: preserves toolCallId/toolName/isError on the elided message",
		out[1].toolCallId === "a" && out[1].toolName === "read" && out[1].isError === false,
	);
	check("clear: keeps the most recent result intact (keepRecent)", out[3].content[0].text.length === 300);
	check(
		"clear: leaves non-toolResult messages untouched (identity)",
		out[0] === messages[0] && out[2] === messages[2],
	);
}

async function clearSkipsRecentShortAndErrors(url) {
	const mod = await loadModule(url);
	const clear = mod.clearOldToolResults;
	const opts = { keepRecent: 2, minChars: 500, headChars: 50, tailChars: 50 };
	const short = toolResult("s", 100); // por debajo de minChars
	const err = toolResult("e", 5000, { isError: true }); // error -> conservar completo
	const recent1 = toolResult("r1", 5000);
	const recent2 = toolResult("r2", 5000);
	const messages = [short, err, recent1, recent2];
	const out = clear(messages, opts);
	// short queda (demasiado chico), err queda (error), recent1+recent2 quedan (keepRecent:2).
	check("clear: nothing to elide here returns null (short+error+recent only)", out === null, `out=${out && "array"}`);
}

async function clearPreservesImagesAndDoesNotMutate(url) {
	const mod = await loadModule(url);
	const clear = mod.clearOldToolResults;
	const opts = { keepRecent: 0, minChars: 500, headChars: 50, tailChars: 50 };
	const img = { type: "image", data: "base64", mimeType: "image/png" };
	const original = toolResult("a", 5000, { extra: [img] });
	const snapshotBefore = JSON.stringify(original);
	const messages = [original];
	const out = clear(messages, opts);
	check(
		"clear: image block is preserved alongside elided text",
		!!out && out[0].content.some((b) => b.type === "image"),
	);
	check("clear: does NOT mutate the input message (originals unchanged)", JSON.stringify(original) === snapshotBefore);
	check("clear: input array is not mutated", messages[0] === original);
}

async function clearIsIdempotent(url) {
	const mod = await loadModule(url);
	const clear = mod.clearOldToolResults;
	const opts = { keepRecent: 0, minChars: 500, headChars: 50, tailChars: 50 };
	const messages = [toolResult("a", 5000)];
	const once = clear(messages, opts);
	check("clear: first pass elides", !!once && once[0].content[0].text.includes(mod.CLEARED_SENTINEL));
	const twice = clear(once, opts);
	check("clear: second pass is a no-op (idempotent -> null)", twice === null, `twice=${twice && "array"}`);
}

async function clearFailSafeOnMalformed(url) {
	const mod = await loadModule(url);
	const clear = mod.clearOldToolResults;
	const opts = { keepRecent: 0, minChars: 10, headChars: 50, tailChars: 50 };
	check("clear: non-array input returns null", clear(null, opts) === null && clear(undefined, opts) === null);
	check("clear: empty array returns null", clear([], opts) === null);
	check("clear: no tool results returns null", clear([{ role: "user", content: "hi" }], opts) === null);
}

// Integración: el hook `context` devuelve mensajes modificados solo cuando la limpieza está
// habilitada (OFF de forma predeterminada), y nunca arroja.
async function contextHookGatedByToggle(url) {
	const { handlers, commands } = await loadExtension(url);
	const env = makeEnv();
	const ctxHandler = requireFunction("context: handler is registered", handlers.get("context"));
	if (!ctxHandler) return;
	// El keepRecent predeterminado es 3, así que necesitamos >3 tool results para que el más viejo pueda limpiarse.
	const event = {
		type: "context",
		messages: [toolResult("a", 5000), toolResult("b", 5000), toolResult("c", 5000), toolResult("d", 5000)],
	};

	const whenOff = await ctxHandler(event, env.ctx);
	check(
		"context: disabled by default -> no modification",
		whenOff === undefined || whenOff == null,
		`got ${JSON.stringify(whenOff)}`,
	);

	await commands.get("auto-compact").handler("clear-tools on", env.ctx);
	const whenOn = await ctxHandler(event, env.ctx);
	check(
		"context: enabled -> returns { messages } with the old result elided",
		!!whenOn && Array.isArray(whenOn.messages) && /cleared/.test(whenOn.messages[0].content[0].text),
		`got ${whenOn && typeof whenOn}`,
	);
}

// Pinea el mapeo nivel → token de tema de la barra del footer (BAR_LEVEL_COLOR, export nombrado).
// La barra empieza verde (`success`) cuando el uso está bajo; el estado urgente
// (over/compacting) debe usar `error` para leerse como alerta, no `accent`
// (que se comparte con selección/logo y no comunica peligro).
async function barLevelColorCases(url) {
	const mod = await loadModule(url);
	const map = requireObject("BAR_LEVEL_COLOR: exported", mod.BAR_LEVEL_COLOR);
	if (!map) return;
	check("BAR_LEVEL_COLOR: idle → success (green)", map.idle === "success", `got ${map.idle}`);
	check("BAR_LEVEL_COLOR: near → warning", map.near === "warning", `got ${map.near}`);
	check("BAR_LEVEL_COLOR: over → error (urgent)", map.over === "error", `got ${map.over}`);
	check("BAR_LEVEL_COLOR: compacting → error (urgent)", map.compacting === "error", `got ${map.compacting}`);
}

// El aviso de ACTIVACIÓN de la auto-compactación lleva el dibujo de un autito (arte ASCII
// multilínea exportado como COMPACT_CAR); el aviso de completada queda limpio de arte.
async function compactionNoticeShowsCar(url) {
	const mod = await loadModule(url);
	const car = mod.COMPACT_CAR;
	check(
		"car: COMPACT_CAR exported as multi-line ASCII art",
		typeof car === "string" && car.includes("\n"),
		`got ${typeof car}`,
	);

	const { handlers } = await loadExtension(url);
	const env = makeEnv();
	env.state.percent = 60;
	env.state.reduceTo = 20;
	await fireAgentEnd(handlers, env.ctx); // cruce genuino -> compactación #1

	const activation = env.notes.find((n) => n.m.includes("Compactando el contexto automáticamente"));
	check("car: activation notice exists", !!activation, `notes=${JSON.stringify(env.notes)}`);
	check(
		"car: activation notice includes the car drawing",
		!!car && !!activation && activation.m.includes(car),
		`got ${activation?.m}`,
	);

	const completion = env.notes.find((n) => n.m.includes("Auto-compactación completada"));
	check(
		"car: completion notice stays art-free",
		!!completion && (!car || !completion.m.includes(car)),
		`got ${completion?.m}`,
	);
}

async function main() {
	const url = await build();
	await compactionNoticeShowsCar(url);
	await stuckAboveThresholdDoesNotLoop(url);
	await failedCompactionReArmsAndRetriggers(url);
	await genuineRecrossRetriggers(url);
	await belowThresholdNeverCompacts(url);
	await codexDefaultThresholdIsFifty(url);
	await claudeDefaultThresholdRemainsThirtyFive(url);
	await parseThresholdEdgeCases(url);
	await renderContextBarCases(url);
	await barLevelColorCases(url);
	await parseBarSettingCases(url);
	await barReflectsUsageBelowThreshold(url);
	await barShowsCompactingState(url);
	await barToggleClearsAndRestores(url);
	await barClearedWhenDisabled(url);
	await defaultThresholdContract(url);
	await argumentCompletions(url);
	await bareCommandOpensMenuAndDisables(url);
	await menuThresholdPresetSetsThreshold(url);
	await menuThresholdCustomUsesInput(url);
	await bareCommandWithoutUiNeverOpensMenu(url);
	await bareCommandWithUiButNoSelectFallsBackToStatus(url);
	await menuCustomThresholdWithoutInputFallsBackToStatus(url);
	await snapshotWritesRawEntries(url);
	await snapshotPatchesSummary(url);
	await snapshotDisabledWritesNothing(url);
	await snapshotIsFailSafe(url);
	await snapshotRetentionPrunes(url);
	await snapshotPureHelpers(url);
	await fastSummaryPureHelpers(url);
	await fastSummaryProvidesCustomCompaction(url);
	await fastSummaryPrefersCodex55ForCodexSessions(url);
	await fastSummaryFallsBackWhenAuthFails(url);
	await fastSummaryCommandToggle(url);
	await clearElidesOldLargeResults(url);
	await clearSkipsRecentShortAndErrors(url);
	await clearPreservesImagesAndDoesNotMutate(url);
	await clearIsIdempotent(url);
	await clearFailSafeOnMalformed(url);
	await contextHookGatedByToggle(url);

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.error(counts.failures.join("\n"));
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err?.stack || err);
	process.exit(1);
});
