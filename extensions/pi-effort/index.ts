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
import { THINKING_LEVELS, parseEffortTarget } from "./parse.js";
import type { EffortTarget, ThinkingLevel } from "./parse.js";

const EFFORT_STATUS_KEY = "effort";
// Keep this string in sync with extensions/dynamic-workflows/index.ts. The event is
// intentionally best-effort: `/effort` still works as a thinking-level command
// when the dynamic-workflows extension is not loaded.
const ULTRACODE_MODE_EVENT = "pi-dynamic-workflows:ultracode-mode";

const COMPLETIONS: Array<{ value: string; description: string }> = [
	{ value: "off", description: "Disable model thinking/reasoning" },
	{ value: "minimal", description: "Minimal thinking" },
	{ value: "low", description: "Low thinking" },
	{ value: "medium", description: "Medium thinking" },
	{ value: "high", description: "High thinking" },
	{ value: "xhigh", description: "Extra-high thinking" },
	{ value: "ultracode", description: "Extra-high thinking + dynamic workflow router" },
	{ value: "status", description: "Show current effort" },
	{ value: "none", description: "Alias for off" },
	{ value: "max", description: "Alias for xhigh" },
	{ value: "ultra-code", description: "Alias for ultracode" },
];

const SELECT_ITEMS = [
	"off — disable thinking",
	"minimal — minimal thinking",
	"low — low thinking",
	"medium — medium thinking",
	"high — high thinking",
	"xhigh — extra-high thinking",
	"ultracode — xhigh + dynamic workflow router",
];

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.mode === "print") {
		// stdout carries machine-readable output in print mode; keep warnings/errors on stderr.
		(type === "info" ? console.log : console.error)(message);
		return;
	}
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	// Headless without UI: surface problems on stderr instead of silently dropping them.
	if (type !== "info") console.error(message);
}

function usage(current: string): string {
	return `Current effort: ${current}. Usage: /effort <off|minimal|low|medium|high|xhigh|ultracode>`;
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
		notify(ctx, `Failed to set effort ${level}: ${message}`, "error");
		return before;
	}

	const actual = safeCurrentLevel(pi);
	updateEffortStatus(pi, ctx, actual);
	if (options.announce !== false) {
		if (actual === level) {
			notify(ctx, `Thinking effort set to ${actual}.`, "info");
		} else {
			notify(
				ctx,
				`Requested effort ${level}; active effort is ${actual} (the current model may clamp thinking).`,
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

	const choice = await ctx.ui.select("Select thinking effort", SELECT_ITEMS);
	return choice?.split(/\s+/)[0] ?? "status";
}

function enableUltracodeEffort(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const actual = setThinkingEffort(pi, ctx, "xhigh", { announce: false });
	const workflowToolActive = ensureToolActive(pi, "dynamic_workflow");
	pi.events.emit(ULTRACODE_MODE_EVENT, { enabled: true, source: "/effort" });
	const routerStatus = workflowToolActive
		? "dynamic workflow router enabled"
		: "dynamic workflow router requested, but dynamic_workflow is not available in this session";
	notify(ctx, `Ultracode effort enabled (${actual}); ${routerStatus}.`, workflowToolActive ? "info" : "warning");
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
		notify(ctx, `Unknown effort "${target.value}". ${usage(current)}`, "warning");
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
		description: "Set thinking effort: off|minimal|low|medium|high|xhigh|ultracode",
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
