/**
 * Claude-style `/effort` command for Pi.
 *
 * Pi already has thinking levels internally (`off`, `minimal`, `low`, `medium`,
 * `high`, `xhigh`) plus built-in keyboard/settings controls. This extension adds a
 * slash-command surface that mirrors Claude-style effort switching:
 *
 *   /effort high       -> pi.setThinkingLevel("high")
 *   /effort xhigh      -> pi.setThinkingLevel("xhigh")
 *   /effort ultracode  -> xhigh + request the dynamic-workflows ultracode router
 *
 * The actual level may be clamped by the active model (non-reasoning models become
 * `off`); after every change we report the active level from `pi.getThinkingLevel()`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notify } from "./notify.js";
import type { EffortTarget, ThinkingLevel } from "./parse.js";
import { parseEffortTarget, THINKING_LEVELS } from "./parse.js";

const EFFORT_STATUS_KEY = "effort";
// Keep this string in sync with extensions/dynamic-workflows/index.ts. The event is
// intentionally best-effort: `/effort` still works as a thinking-level command
// when the dynamic-workflows extension is not loaded.
const ULTRACODE_MODE_EVENT = "pandi-dynamic-workflows:ultracode-mode";

const COMPLETIONS: { value: string; description: string }[] = [
	{ value: "off", description: "Desactivar el thinking/reasoning del modelo" },
	{ value: "minimal", description: "Thinking mínimo" },
	{ value: "low", description: "Thinking bajo" },
	{ value: "medium", description: "Thinking medio" },
	{ value: "high", description: "Thinking alto" },
	{ value: "xhigh", description: "Thinking extra alto" },
	{ value: "ultracode", description: "Thinking extra alto + router de dynamic workflow" },
	{ value: "status", description: "Mostrar el esfuerzo actual" },
	{ value: "none", description: "Alias de off" },
	{ value: "max", description: "Alias de xhigh" },
	{ value: "ultra-code", description: "Alias de ultracode" },
];

const SELECT_ITEMS = [
	"off — desactivar el thinking",
	"minimal — thinking mínimo",
	"low — thinking bajo",
	"medium — thinking medio",
	"high — thinking alto",
	"xhigh — thinking extra alto",
	"ultracode — xhigh + router de dynamic workflow",
];

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
		const message = error instanceof Error ? error.message : String(error);
		notify(ctx, `No se pudo configurar el esfuerzo ${level}: ${message}`, "error");
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
		// Show the resolved/clamped active level (safeCurrentLevel) like every other
		// status update, not the requested event.level which the model may not accept.
		updateEffortStatus(pi, ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		updateEffortStatus(pi, ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(EFFORT_STATUS_KEY, undefined);
	});
}
