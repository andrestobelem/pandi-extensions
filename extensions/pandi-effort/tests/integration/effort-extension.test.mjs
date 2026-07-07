#!/usr/bin/env node
/**
 * Prueba de integración de comportamiento duradero para extensions/pandi-effort/index.ts.
 *
 * Fija el contrato público de /effort:
 * - los niveles nombrados llaman a pi.setThinkingLevel e informan el nivel activo limitado
 * - alias como `none` y `thinking=max` se mapean a niveles de thinking de Pi
 * - el uso en TUI sin argumentos abre un selector
 * - `ultracode` configura xhigh, activa dynamic_workflow cuando está presente y emite el
 *   evento entre extensiones que consume dynamic-workflows.ts
 * - thinking_level_select mantiene sincronizada la línea de estado
 * - ramas de degradación (issue #2, verificadas por mutación y no vacuas): si setThinkingLevel
 *   lanza, queda contenido (error notify, se informa el nivel previo a la llamada),
 *   safeCurrentLevel mapea throw/valores fuera del vocabulario a "unknown", un
 *   getActiveTools que lanza degrada ultracode a "router not available", headless sin
 *   argumentos nunca abre el selector (usage en stdout en modo print), un selector
 *   cancelado vuelve a status, los alias sueltos `max` / `ultra-code` resuelven de punta
 *   a punta, y session_start/shutdown pintan/limpian la línea de estado (nunca sin UI)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildEffort() {
	return await buildExtension({
		name: "pi-effort-integration",
		src: path.join(REPO_ROOT, "extensions", "pandi-effort", "index.ts"),
		outName: "effort.mjs",
	});
}

function makePi({ initialLevel = "medium", allTools = [], activeTools = [], clamp } = {}) {
	let level = initialLevel;
	let active = [...activeTools];
	const commands = new Map();
	const handlers = new Map();
	const emitted = [];
	const pi = {
		registerCommand: (name, opts) => commands.set(name, opts),
		on: (event, handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		getThinkingLevel: () => level,
		setThinkingLevel: (next) => {
			level = clamp ? clamp(next) : next;
		},
		getActiveTools: () => [...active],
		getAllTools: () => allTools.map((name) => ({ name })),
		setActiveTools: (names) => {
			active = [...names];
		},
		events: {
			emit: (event, data) => emitted.push({ event, data }),
		},
	};
	return {
		pi,
		commands,
		handlers,
		emitted,
		get level() {
			return level;
		},
		get activeTools() {
			return active;
		},
	};
}

function makeCtx({ mode = "tui", hasUI = true, selectResult } = {}) {
	const notes = [];
	const statuses = [];
	const ctx = {
		mode,
		hasUI,
		ui: {
			theme: { fg: (_c, s) => s },
			notify: (msg, type) => notes.push({ msg, type }),
			setStatus: (key, value) => statuses.push({ key, value }),
			select: async () => selectResult,
		},
	};
	ctx._notes = notes;
	ctx._statuses = statuses;
	return ctx;
}

async function fire(handlers, event, payload, ctx) {
	for (const handler of handlers.get(event) || []) await handler(payload, ctx);
}

async function withCapturedConsole(fn) {
	const out = [];
	const err = [];
	const savedLog = console.log;
	const savedError = console.error;
	console.log = (...messages) => out.push(messages.map(String).join(" "));
	console.error = (...messages) => err.push(messages.map(String).join(" "));
	try {
		await fn();
	} finally {
		console.log = savedLog;
		console.error = savedError;
	}
	return { out, err };
}

async function scenarioLevels(url) {
	const effortExtension = await loadDefault(url);
	const harness = makePi();
	effortExtension(harness.pi);
	const command = harness.commands.get("effort");
	check("/effort command registered", !!command);
	const allCompletions = command.getArgumentCompletions("");
	check("/effort has completions", Array.isArray(command.getArgumentCompletions("h")));
	check(
		"/effort autocomplete includes canonical levels",
		["off", "minimal", "low", "medium", "high", "xhigh", "ultracode", "status"].every((value) =>
			allCompletions.some((item) => item.value === value),
		),
	);
	check(
		"/effort autocomplete includes max alias",
		command.getArgumentCompletions("ma")?.some((item) => item.value === "max"),
	);
	check(
		"/effort autocomplete includes ultra-code alias",
		command.getArgumentCompletions("ultra-")?.some((item) => item.value === "ultra-code"),
	);

	const ctx = makeCtx();
	await command.handler("high", ctx);
	check("/effort high sets high", harness.level === "high", harness.level);
	check(
		"/effort high notifies",
		ctx._notes.some((n) => /configurado en high/i.test(n.msg)),
	);
	check(
		"/effort high updates status",
		ctx._statuses.some((s) => s.key === "effort" && s.value === "effort:high"),
	);

	await command.handler("none", ctx);
	check("/effort none aliases off", harness.level === "off", harness.level);

	await command.handler("thinking=max", ctx);
	check("/effort thinking=max aliases xhigh", harness.level === "xhigh", harness.level);
}

async function scenarioClampAndInvalid(url) {
	const effortExtension = await loadDefault(url);
	const harness = makePi({
		initialLevel: "medium",
		clamp: (next) => (next === "xhigh" ? "high" : next),
	});
	effortExtension(harness.pi);
	const command = harness.commands.get("effort");
	const ctx = makeCtx();

	await command.handler("xhigh", ctx);
	check("/effort reports clamped active level", harness.level === "high", harness.level);
	check(
		"/effort clamp warning",
		ctx._notes.some((n) => n.type === "warning" && /esfuerzo activo es high/i.test(n.msg)),
	);

	const before = harness.level;
	await command.handler("banana", ctx);
	check("/effort invalid does not change level", harness.level === before, `${before} -> ${harness.level}`);
	check(
		"/effort invalid shows usage",
		ctx._notes.some((n) => /Esfuerzo desconocido/i.test(n.msg) && /Uso: \/effort/.test(n.msg)),
	);
}

async function scenarioSelectorAndStatusEvent(url) {
	const effortExtension = await loadDefault(url);
	const harness = makePi({ initialLevel: "medium" });
	effortExtension(harness.pi);
	const command = harness.commands.get("effort");
	const ctx = makeCtx({ selectResult: "low — esfuerzo bajo" });

	await command.handler("", ctx);
	check("/effort no args uses selector choice", harness.level === "low", harness.level);

	await fire(harness.handlers, "thinking_level_select", { level: "minimal", previousLevel: "low" }, ctx);
	const lastStatus = ctx._statuses[ctx._statuses.length - 1];
	check(
		"thinking_level_select shows resolved active level, not requested event.level",
		lastStatus && lastStatus.key === "effort" && lastStatus.value === "effort:low",
		JSON.stringify(ctx._statuses),
	);

	await command.handler("status", ctx);
	check(
		"/effort status reports current",
		ctx._notes.some((n) => /Esfuerzo actual: low/i.test(n.msg)),
	);
}

async function scenarioUltracode(url) {
	const effortExtension = await loadDefault(url);
	const harness = makePi({ allTools: ["read", "dynamic_workflow"], activeTools: ["read"] });
	effortExtension(harness.pi);
	const command = harness.commands.get("effort");
	const ctx = makeCtx();

	await command.handler("ultracode", ctx);
	check("/effort ultracode sets xhigh", harness.level === "xhigh", harness.level);
	check(
		"/effort ultracode activates dynamic_workflow",
		harness.activeTools.includes("dynamic_workflow"),
		harness.activeTools.join(","),
	);
	check(
		"/effort ultracode emits router event",
		harness.emitted.some(
			(e) =>
				e.event === "pandi-dynamic-workflows:ultracode-mode" &&
				e.data?.enabled === true &&
				e.data?.source === "/effort",
		),
		JSON.stringify(harness.emitted),
	);
	check(
		"/effort ultracode notifies",
		ctx._notes.some((n) => /Esfuerzo ultracode habilitado/i.test(n.msg)),
	);
}

// F50/F51: notify() no debe enviar warnings/errors a stdout en modo print, ni
// descartarlos en silencio cuando está headless (sin UI, no print).
// Finding 3: vía de degradación documentada. Cuando dynamic_workflow no está disponible en esta
// sesión, /effort ultracode igual debe subir thinking a xhigh, NO debe activar una tool
// que no existe y debe advertir que el router no está disponible.
async function scenarioUltracodeToolUnavailable(url) {
	const effortExtension = await loadDefault(url);
	const harness = makePi({ allTools: ["read"], activeTools: ["read"] });
	effortExtension(harness.pi);
	const command = harness.commands.get("effort");
	const ctx = makeCtx();

	await command.handler("ultracode", ctx);
	check("/effort ultracode still sets xhigh without dynamic_workflow", harness.level === "xhigh", harness.level);
	check(
		"/effort ultracode does not activate a missing dynamic_workflow",
		!harness.activeTools.includes("dynamic_workflow"),
		harness.activeTools.join(","),
	);
	check(
		"/effort ultracode warns the router is not available in this session",
		ctx._notes.some((n) => n.type === "warning" && /no está disponible en esta sesión/i.test(n.msg)),
		JSON.stringify(ctx._notes),
	);
}

async function scenarioNotifyErrorRouting(url) {
	const effortExtension = await loadDefault(url);
	const harness = makePi({ initialLevel: "medium" });
	effortExtension(harness.pi);
	const command = harness.commands.get("effort");

	// F50: en modo print, stdout lleva datos legibles por máquina; warnings/errors van a stderr.
	const printCtx = makeCtx({ mode: "print", hasUI: false });
	const { out: pLogs, err: pErrs } = await withCapturedConsole(() => command.handler("banana", printCtx));
	check(
		"print mode routes invalid-effort warning to stderr, not stdout",
		pErrs.some((m) => /Esfuerzo desconocido/i.test(m)) && !pLogs.some((m) => /Esfuerzo desconocido/i.test(m)),
		`logs=${JSON.stringify(pLogs)} errs=${JSON.stringify(pErrs)}`,
	);

	// F51: headless (sin UI, no print) debe mostrar warnings/errors en stderr, no descartarlos.
	const headlessCtx = makeCtx({ mode: "tui", hasUI: false });
	const { err: hErrs } = await withCapturedConsole(() => command.handler("banana", headlessCtx));
	check(
		"headless mode surfaces invalid-effort warning on stderr (not dropped)",
		hErrs.some((m) => /Esfuerzo desconocido/i.test(m)),
		`errs=${JSON.stringify(hErrs)}`,
	);
}

// Si setThinkingLevel lanza (provider/model rechaza el cambio), debe quedar contenido:
// error notify, el reporte de nivel vuelve al nivel previo a la llamada y no hay success notify.
async function scenarioSetLevelThrows(url) {
	const effortExtension = await loadDefault(url);
	const harness = makePi({ initialLevel: "medium" });
	harness.pi.setThinkingLevel = () => {
		throw new Error("model rejects thinking");
	};
	effortExtension(harness.pi);
	const command = harness.commands.get("effort");
	const ctx = makeCtx();

	await command.handler("high", ctx);
	check("setLevel throw: level unchanged", harness.level === "medium", harness.level);
	check(
		"setLevel throw: error notify carries the failure",
		ctx._notes.some(
			(n) => n.type === "error" && /No se pudo configurar el esfuerzo high: model rejects thinking/.test(n.msg),
		),
		JSON.stringify(ctx._notes),
	);
	check(
		"setLevel throw: no success notify",
		!ctx._notes.some((n) => /configurado en/i.test(n.msg)),
		JSON.stringify(ctx._notes),
	);
}

// Degradación de safeCurrentLevel: un getThinkingLevel que lanza o devuelve algo fuera del
// vocabulario debe mostrarse como "unknown" en la línea de uso/estado; nunca debe romper el handler.
async function scenarioUnknownCurrentLevel(url) {
	const effortExtension = await loadDefault(url);
	const throwing = makePi();
	throwing.pi.getThinkingLevel = () => {
		throw new Error("no session");
	};
	effortExtension(throwing.pi);
	const ctx = makeCtx();
	await throwing.commands.get("effort").handler("status", ctx);
	check(
		"getThinkingLevel throw: status reports 'unknown'",
		ctx._notes.some((n) => /Esfuerzo actual: unknown/.test(n.msg)),
		JSON.stringify(ctx._notes),
	);

	const weird = makePi({ initialLevel: "banana" });
	effortExtension(weird.pi);
	const ctx2 = makeCtx();
	await weird.commands.get("effort").handler("status", ctx2);
	check(
		"out-of-vocabulary level: status reports 'unknown'",
		ctx2._notes.some((n) => /Esfuerzo actual: unknown/.test(n.msg)),
		JSON.stringify(ctx2._notes),
	);
}

// Contención de ensureToolActive: un getActiveTools que lanza debe degradarse a "router not
// available" (warning), nunca romper /effort ultracode; y un router ya activo
// no debe reactivarse (sin llamada a setActiveTools) y aun así debe informarse como habilitado.
async function scenarioUltracodeToolProbeDegradation(url) {
	const effortExtension = await loadDefault(url);
	const throwing = makePi({ allTools: ["dynamic_workflow"], activeTools: [] });
	throwing.pi.getActiveTools = () => {
		throw new Error("tools unavailable");
	};
	effortExtension(throwing.pi);
	const ctx = makeCtx();
	await throwing.commands.get("effort").handler("ultracode", ctx);
	check("tool probe throw: still sets xhigh", throwing.level === "xhigh", throwing.level);
	check(
		"tool probe throw: warns router not available",
		ctx._notes.some((n) => n.type === "warning" && /no está disponible en esta sesión/i.test(n.msg)),
		JSON.stringify(ctx._notes),
	);

	const alreadyActive = makePi({ allTools: ["dynamic_workflow"], activeTools: ["dynamic_workflow"] });
	let setCalls = 0;
	const origSet = alreadyActive.pi.setActiveTools;
	alreadyActive.pi.setActiveTools = (names) => {
		setCalls += 1;
		origSet(names);
	};
	effortExtension(alreadyActive.pi);
	const ctx2 = makeCtx();
	await alreadyActive.commands.get("effort").handler("ultracode", ctx2);
	check("already-active router: no redundant setActiveTools", setCalls === 0, `setCalls=${setCalls}`);
	check(
		"already-active router: reports enabled (info)",
		ctx2._notes.some((n) => n.type === "info" && /router de dynamic_workflow habilitado/i.test(n.msg)),
		JSON.stringify(ctx2._notes),
	);
}

// Bordes de resolveCommandValue: headless sin argumentos NO debe abrir un selector (usage en su lugar);
// un selector cancelado (undefined) debe volver a status sin cambiar nada.
async function scenarioNoArgsEdges(url) {
	const effortExtension = await loadDefault(url);
	const headless = makePi({ initialLevel: "medium" });
	effortExtension(headless.pi);
	let selectCalls = 0;
	// modo print + sin UI: la línea de uso/estado debe caer en stdout (la info headless,
	// de otro modo, se descarta por diseño — ver notify.ts), y el selector nunca debe abrirse.
	const ctx = makeCtx({ mode: "print", hasUI: false });
	ctx.ui.select = async () => {
		selectCalls += 1;
		return "high — esfuerzo alto";
	};
	const { out: logs } = await withCapturedConsole(() => headless.commands.get("effort").handler("", ctx));
	check("headless no-args: selector never opens", selectCalls === 0, `selectCalls=${selectCalls}`);
	check("headless no-args: level unchanged", headless.level === "medium", headless.level);
	check(
		"headless no-args: reports status/usage on stdout (print mode)",
		logs.some((m) => /Esfuerzo actual: medium/.test(m)),
		JSON.stringify(logs),
	);

	const cancelled = makePi({ initialLevel: "medium" });
	effortExtension(cancelled.pi);
	const ctx2 = makeCtx({ selectResult: undefined });
	await cancelled.commands.get("effort").handler("", ctx2);
	check("cancelled selector: level unchanged", cancelled.level === "medium", cancelled.level);
	check(
		"cancelled selector: falls back to status/usage",
		ctx2._notes.some((n) => /Esfuerzo actual: medium/.test(n.msg)),
		JSON.stringify(ctx2._notes),
	);
}

// Manejo de alias de punta a punta (no solo autocomplete): `max` solo -> xhigh, y el
// alias `ultra-code` -> la ruta completa de ultracode (event + router).
async function scenarioAliasHandling(url) {
	const effortExtension = await loadDefault(url);
	const harness = makePi({ allTools: ["dynamic_workflow"], activeTools: [] });
	effortExtension(harness.pi);
	const command = harness.commands.get("effort");
	const ctx = makeCtx();

	await command.handler("max", ctx);
	check("/effort max aliases xhigh", harness.level === "xhigh", harness.level);

	await command.handler("ultra-code", ctx);
	check(
		"/effort ultra-code runs the ultracode path (router event emitted)",
		harness.emitted.some((e) => e.event === "pandi-dynamic-workflows:ultracode-mode" && e.data?.enabled === true),
		JSON.stringify(harness.emitted),
	);
	check(
		"/effort ultra-code activates the router tool",
		harness.activeTools.includes("dynamic_workflow"),
		harness.activeTools.join(","),
	);
}

// Ciclo de vida de la sesión: session_start pinta el estado, session_shutdown lo limpia
// (undefined) y ninguno toca la línea de estado sin UI.
async function scenarioSessionLifecycle(url) {
	const effortExtension = await loadDefault(url);
	const harness = makePi({ initialLevel: "high" });
	effortExtension(harness.pi);
	const ctx = makeCtx();

	await fire(harness.handlers, "session_start", {}, ctx);
	check(
		"session_start paints the current effort status",
		ctx._statuses.some((s) => s.key === "effort" && s.value === "effort:high"),
		JSON.stringify(ctx._statuses),
	);

	await fire(harness.handlers, "session_shutdown", {}, ctx);
	const last = ctx._statuses[ctx._statuses.length - 1];
	check(
		"session_shutdown clears the effort status",
		last && last.key === "effort" && last.value === undefined,
		JSON.stringify(last),
	);

	const noUi = makeCtx({ hasUI: false });
	await fire(harness.handlers, "session_start", {}, noUi);
	await fire(harness.handlers, "session_shutdown", {}, noUi);
	check("no-UI lifecycle never touches the status line", noUi._statuses.length === 0, JSON.stringify(noUi._statuses));
}

async function main() {
	const { outDir, url } = await buildEffort();
	try {
		await scenarioLevels(url);
		await scenarioClampAndInvalid(url);
		await scenarioSelectorAndStatusEvent(url);
		await scenarioUltracode(url);
		await scenarioUltracodeToolUnavailable(url);
		await scenarioNotifyErrorRouting(url);
		await scenarioSetLevelThrows(url);
		await scenarioUnknownCurrentLevel(url);
		await scenarioUltracodeToolProbeDegradation(url);
		await scenarioNoArgsEdges(url);
		await scenarioAliasHandling(url);
		await scenarioSessionLifecycle(url);
	} finally {
		await fs.rm(outDir, { recursive: true, force: true });
	}

	console.log(`\n${counts.passed} aprobadas, ${counts.failed} fallidas`);
	if (counts.failed) {
		console.log("Fallos:");
		for (const failure of counts.failures) console.log(`- ${failure}`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(2);
});
