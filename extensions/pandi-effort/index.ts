/**
 * Comando `/effort` estilo Claude para Pi.
 *
 * Pi ya tiene niveles de thinking internos (`off`, `minimal`, `low`, `medium`,
 * `high`, `xhigh`) y controles integrados de teclado/configuración. Esta extensión agrega una
 * interfaz de slash-command que refleja el cambio de esfuerzo estilo Claude:
 *
 *   /effort high       -> pi.setThinkingLevel("high")
 *   /effort xhigh      -> pi.setThinkingLevel("xhigh")
 *   /effort ultracode  -> xhigh + pedir el router ultracode de dynamic-workflows
 *
 * El nivel real puede quedar limitado por el modelo activo (los modelos sin reasoning pasan a
 * `off`); después de cada cambio informamos el nivel activo desde `pi.getThinkingLevel()`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notify } from "./notify.js";
import type { EffortTarget, ThinkingLevel } from "./parse.js";
import { parseEffortTarget, THINKING_LEVELS } from "./parse.js";

const EFFORT_STATUS_KEY = "effort";
// Mantené este string sincronizado con extensions/dynamic-workflows/index.ts. El evento es
// intencionalmente best-effort: `/effort` igual funciona como comando de nivel de thinking
// cuando la extensión dynamic-workflows no está cargada.
const ULTRACODE_MODE_EVENT = "pandi-dynamic-workflows:ultracode-mode";

const CANONICAL_EFFORT_OPTIONS: {
	value: ThinkingLevel | "ultracode" | "status";
	description: string;
	selectLabel?: string;
}[] = [
	{
		value: "off",
		description: "Desactivar el thinking/reasoning del modelo",
		selectLabel: "off — desactivar el thinking",
	},
	{ value: "minimal", description: "Thinking mínimo", selectLabel: "minimal — thinking mínimo" },
	{ value: "low", description: "Thinking bajo", selectLabel: "low — thinking bajo" },
	{ value: "medium", description: "Thinking medio", selectLabel: "medium — thinking medio" },
	{ value: "high", description: "Thinking alto", selectLabel: "high — thinking alto" },
	{ value: "xhigh", description: "Thinking extra alto", selectLabel: "xhigh — thinking extra alto" },
	{
		value: "ultracode",
		description: "Thinking extra alto + router de dynamic workflow",
		selectLabel: "ultracode — xhigh + router de dynamic workflow",
	},
	{ value: "status", description: "Mostrar el esfuerzo actual" },
];

const ALIAS_COMPLETIONS: { value: string; description: string }[] = [
	{ value: "none", description: "Alias de off" },
	{ value: "max", description: "Alias de xhigh" },
	{ value: "ultra-code", description: "Alias de ultracode" },
];

const COMPLETIONS: { value: string; description: string }[] = [
	...CANONICAL_EFFORT_OPTIONS.map(({ value, description }) => ({ value, description })),
	...ALIAS_COMPLETIONS,
];

const SELECT_ITEMS = CANONICAL_EFFORT_OPTIONS.flatMap((item) => (item.selectLabel ? [item.selectLabel] : []));

function usage(current: string): string {
	return `Esfuerzo actual: ${current}. Uso: /effort <off|minimal|low|medium|high|xhigh|ultracode>`;
}

function safeCurrentLevel(pi: ExtensionAPI): ThinkingLevel | "unknown" {
	try {
		const level = pi.getThinkingLevel();
		return THINKING_LEVELS.includes(level) ? level : "unknown";
	} catch {
		return "unknown";
	}
}

function formatEffortStatus(ctx: ExtensionContext, level: string): string {
	const theme = ctx.ui.theme;
	const text = `effort:${level}`;
	if (level === "off") return theme.fg("dim", text);
	if (level === "minimal" || level === "low") return theme.fg("muted", text);
	if (level === "high" || level === "xhigh") return theme.fg("accent", text);
	return text;
}

function updateEffortStatus(pi: ExtensionAPI, ctx: ExtensionContext, level = safeCurrentLevel(pi)): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(EFFORT_STATUS_KEY, formatEffortStatus(ctx, level));
}

function formatSetEffortFailure(level: ThinkingLevel, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return `No se pudo configurar el esfuerzo ${level}: ${message}`;
}

function setThinkingEffort(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	level: ThinkingLevel,
	options: { announce?: boolean } = {},
): ThinkingLevel | "unknown" {
	const before = safeCurrentLevel(pi);
	try {
		pi.setThinkingLevel(level);
	} catch (error) {
		notify(ctx, formatSetEffortFailure(level, error), "error");
		return before;
	}

	const actual = safeCurrentLevel(pi);
	updateEffortStatus(pi, ctx, actual);
	if (options.announce !== false) {
		if (actual === level) {
			notify(ctx, `Esfuerzo de pensamiento configurado en ${actual}.`, "info");
		} else {
			notify(
				ctx,
				`Se pidió el esfuerzo ${level}; el esfuerzo activo es ${actual} (el modelo actual puede limitar el thinking).`,
				"warning",
			);
		}
	}
	return actual;
}

function ensureToolActive(pi: ExtensionAPI, toolName: string): boolean {
	try {
		const active = pi.getActiveTools();
		if (active.includes(toolName)) return true;
		const exists = pi.getAllTools().some((tool) => tool.name === toolName);
		if (!exists) return false;
		pi.setActiveTools([...new Set([...active, toolName])]);
		return true;
	} catch {
		return false;
	}
}

async function resolveCommandValue(args: string, ctx: ExtensionContext): Promise<string> {
	const trimmed = args.trim();
	if (trimmed || !ctx.hasUI) return trimmed;

	const choice = await ctx.ui.select("Seleccioná el esfuerzo de pensamiento", SELECT_ITEMS);
	return choice?.split(/\s+/)[0] ?? "status";
}

function enableUltracodeEffort(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const actual = setThinkingEffort(pi, ctx, "xhigh", { announce: false });
	const workflowToolActive = ensureToolActive(pi, "dynamic_workflow");
	pi.events.emit(ULTRACODE_MODE_EVENT, { enabled: true, source: "/effort" });
	const routerStatus = workflowToolActive
		? "router de dynamic workflow habilitado"
		: "se pidió el router de dynamic workflow, pero dynamic_workflow no está disponible en esta sesión";
	notify(ctx, `Esfuerzo ultracode habilitado (${actual}); ${routerStatus}.`, workflowToolActive ? "info" : "warning");
}

function handleEffortTarget(pi: ExtensionAPI, ctx: ExtensionContext, target: EffortTarget): void {
	if (target.kind === "status") {
		const current = safeCurrentLevel(pi);
		updateEffortStatus(pi, ctx, current);
		notify(ctx, usage(current), "info");
		return;
	}

	if (target.kind === "invalid") {
		const current = safeCurrentLevel(pi);
		notify(ctx, `Esfuerzo desconocido "${target.value}". ${usage(current)}`, "warning");
		return;
	}

	if (target.kind === "level") {
		setThinkingEffort(pi, ctx, target.level);
		return;
	}

	enableUltracodeEffort(pi, ctx);
}

export default function effortExtension(pi: ExtensionAPI): void {
	pi.registerCommand("effort", {
		description: "Configurar el esfuerzo de pensamiento: off|minimal|low|medium|high|xhigh|ultracode",
		getArgumentCompletions: (prefix: string) => {
			const needle = prefix.trim().toLowerCase();
			const items = COMPLETIONS.filter((item) => item.value.startsWith(needle));
			return items.length > 0
				? items.map((item) => ({
						value: item.value,
						label: item.value,
						description: item.description,
					}))
				: null;
		},
		handler: async (args, ctx) => {
			const value = await resolveCommandValue(args, ctx);
			handleEffortTarget(pi, ctx, parseEffortTarget(value));
		},
	});

	pi.on("thinking_level_select", async (_event, ctx) => {
		// Mostrá el nivel activo resuelto/limitado (safeCurrentLevel) como en cualquier otra
		// actualización de estado, no el event.level pedido que el modelo quizá no acepte.
		updateEffortStatus(pi, ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		updateEffortStatus(pi, ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(EFFORT_STATUS_KEY, undefined);
	});
}
