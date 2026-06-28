import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_THRESHOLD_PERCENT = 30;

// Footer status key. setStatus is keyed so this extension owns exactly one slot.
const STATUS_KEY = "auto-compact-context";

// Progress-bar glyphs and width. The bar measures progress TOWARD the
// compaction threshold (usage / threshold), so it fills to 100% exactly when
// auto-compaction is about to fire — a meaningful "how close am I" gauge rather
// than a near-empty fraction of the whole context window.
const BAR_FILLED = "\u25B0";
const BAR_EMPTY = "\u25B1";
const BAR_WIDTH = 8;
// Below this fraction of the threshold the bar is calm (muted); at/above it the
// bar warns the user that auto-compaction is approaching.
const NEAR_RATIO = 0.6;

export const parseThreshold = (value: string | undefined): number | undefined => {
	if (!value) return undefined;
	const parsed = Number(value.trim().replace(/%$/, ""));
	if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 100) return undefined;
	return parsed;
};

// Parse an on/off-style setting (env var or subcommand argument). Returns
// undefined for unrecognised input so callers can fall back to a default.
export const parseBarSetting = (value: string | undefined): boolean | undefined => {
	if (value === undefined) return undefined;
	const v = value.trim().toLowerCase();
	if (v === "on" || v === "1" || v === "true" || v === "yes" || v === "show") return true;
	if (v === "off" || v === "0" || v === "false" || v === "no" || v === "hide") return false;
	return undefined;
};

// Interactive menu shown for a bare `/auto-compact-context` in a UI session. The text
// BEFORE " — " is the canonical command the handler already understands.
export const MENU_OPTIONS = [
	"status — show current settings",
	"on — enable auto-compaction",
	"off — disable auto-compaction",
	"run — compact context now",
	"bar on — show the footer progress bar",
	"bar off — hide the footer progress bar",
	"threshold — set the compaction threshold %",
];

// Threshold presets offered after choosing "threshold"; the last entry opens a text input.
export const THRESHOLD_OPTIONS = ["20", "30", "40", "50", "60", "70", "80", "custom\u2026"];

// Argument autocomplete items. `value` is inserted into the editor on accept.
const ARG_COMPLETIONS: { value: string; label: string; description: string }[] = [
	{ value: "status", label: "status", description: "Show current settings" },
	{ value: "on", label: "on", description: "Enable auto-compaction" },
	{ value: "off", label: "off", description: "Disable auto-compaction" },
	{ value: "run", label: "run", description: "Compact context now" },
	{ value: "bar", label: "bar", description: "Toggle the footer progress bar" },
	{ value: "bar on", label: "bar on", description: "Show the footer progress bar" },
	{ value: "bar off", label: "bar off", description: "Hide the footer progress bar" },
	{ value: "20", label: "20%", description: "Set threshold to 20%" },
	{ value: "30", label: "30%", description: "Set threshold to 30% (default)" },
	{ value: "40", label: "40%", description: "Set threshold to 40%" },
	{ value: "50", label: "50%", description: "Set threshold to 50%" },
	{ value: "60", label: "60%", description: "Set threshold to 60%" },
	{ value: "70", label: "70%", description: "Set threshold to 70%" },
	{ value: "80", label: "80%", description: "Set threshold to 80%" },
];

// When invoked bare in a UI session, open a menu to pick a setting (and a second
// menu/input for the threshold value); otherwise return the typed args unchanged.
// Returns a string the command handler already understands.
export async function resolveCommandValue(args: string, ctx: ExtensionContext): Promise<string> {
	const trimmed = args.trim();
	if (trimmed || !ctx.hasUI) return trimmed;

	const choice = await ctx.ui.select("Auto-compact context — choose a setting", MENU_OPTIONS);
	if (!choice) return "status"; // cancelled → harmless no-op (status)
	const command = choice.split(" — ")[0].trim();
	if (command !== "threshold") return command;

	const pick = await ctx.ui.select("Compaction threshold % (compact when usage reaches this)", THRESHOLD_OPTIONS);
	if (!pick) return "status";
	if (!pick.startsWith("custom")) return pick;
	const custom = await ctx.ui.input("Custom threshold percent (1\u201399)", "e.g. 35");
	return (custom ?? "").trim() || "status";
}

export type ContextBarLevel = "idle" | "near" | "over" | "compacting";

export interface ContextBar {
	text: string;
	level: ContextBarLevel;
}

// Pure renderer for the footer progress bar. Kept free of the theme/ctx so it is
// trivially unit-testable; the extension applies color based on `level`.
// Returns null when there is nothing meaningful to show (usage unknown), e.g.
// right after compaction before the next assistant response reports tokens.
export const renderContextBar = (opts: {
	percent: number | null | undefined;
	thresholdPercent: number;
	compacting?: boolean;
	width?: number;
}): ContextBar | null => {
	const width = opts.width ?? BAR_WIDTH;
	if (opts.compacting) {
		return { text: `compact ${BAR_FILLED.repeat(width)} compacting\u2026`, level: "compacting" };
	}
	const { percent, thresholdPercent } = opts;
	if (percent === null || percent === undefined || !Number.isFinite(percent)) return null;
	const ratio = thresholdPercent > 0 ? percent / thresholdPercent : 0;
	const clamped = Math.max(0, Math.min(1, ratio));
	const filled = Math.round(clamped * width);
	const bar = BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(width - filled);
	const label = `${Math.round(percent)}%/${thresholdPercent}%`;
	const level: ContextBarLevel = ratio >= 1 ? "over" : ratio >= NEAR_RATIO ? "near" : "idle";
	return { text: `compact ${bar} ${label}`, level };
};

const BAR_LEVEL_COLOR: Record<ContextBarLevel, "muted" | "warning" | "accent"> = {
	idle: "muted",
	near: "warning",
	over: "accent",
	compacting: "accent",
};

export default function autoCompactContext(pi: ExtensionAPI) {
	let enabled = true;
	let thresholdPercent = parseThreshold(process.env.PI_AUTO_COMPACT_PERCENT) ?? DEFAULT_THRESHOLD_PERCENT;
	let previousPercent: number | null | undefined;
	let pendingReason: string | undefined;
	let compacting = false;
	let showBar = parseBarSetting(process.env.PI_AUTO_COMPACT_BAR) ?? true;

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	};

	// Render (or clear) the footer progress bar. The bar is shown whenever the
	// extension is enabled and the bar is not turned off; it is cleared otherwise
	// so a disabled extension leaves no stale gauge behind.
	const updateStatusBar = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (!enabled || !showBar) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const bar = renderContextBar({
			percent: ctx.getContextUsage()?.percent ?? null,
			thresholdPercent,
			compacting,
		});
		if (!bar) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(BAR_LEVEL_COLOR[bar.level], bar.text));
	};

	const triggerCompaction = (ctx: ExtensionContext, reason: string) => {
		if (compacting) return;
		pendingReason = undefined;
		compacting = true;
		notify(ctx, `Auto-compacting context: ${reason}`, "info");
		updateStatusBar(ctx);

		ctx.compact({
			onComplete: () => {
				compacting = false;
				// Re-arm the edge-trigger from the POST-compaction usage, not null. If
				// compaction could not bring usage below the threshold (large pinned/
				// system content), resetting to null would re-cross every turn and loop.
				previousPercent = ctx.getContextUsage()?.percent ?? null;
				notify(ctx, "Auto-compaction completed", "info");
				updateStatusBar(ctx);
			},
			onError: (error) => {
				compacting = false;
				notify(ctx, `Auto-compaction failed: ${error.message}`, "error");
				updateStatusBar(ctx);
			},
		});
	};

	const updatePendingCompaction = (ctx: ExtensionContext) => {
		if (!enabled || compacting) return;

		const usage = ctx.getContextUsage();
		const currentPercent = usage?.percent ?? null;
		if (currentPercent === null) return;

		const crossedThreshold =
			previousPercent === undefined || previousPercent === null || previousPercent < thresholdPercent;
		previousPercent = currentPercent;

		if (!crossedThreshold || currentPercent < thresholdPercent) return;
		pendingReason = `${Math.round(currentPercent)}% >= ${thresholdPercent}%`;
	};

	pi.on("session_start", (_event, ctx) => {
		updateStatusBar(ctx);
	});

	// turn_end can fire between tool calls inside one assistant turn. Only mark
	// compaction as pending here so the active workflow is not interrupted.
	pi.on("turn_end", (_event, ctx) => {
		updatePendingCompaction(ctx);
		updateStatusBar(ctx);
	});

	// Compact after the assistant turn fully finishes. This preserves the work
	// flow while still compacting before the next user request.
	pi.on("agent_end", (_event, ctx) => {
		updatePendingCompaction(ctx);
		if (!enabled) {
			pendingReason = undefined;
			updateStatusBar(ctx);
			return;
		}
		if (!pendingReason) {
			updateStatusBar(ctx);
			return;
		}
		const reason = pendingReason;
		pendingReason = undefined;
		triggerCompaction(ctx, reason);
	});

	pi.registerCommand("auto-compact-context", {
		description:
			"Configure relative context auto-compaction (default enabled at 30%). Run bare to pick a setting from a menu, or pass status|on|off|run|bar [on|off]|<1-99 percent>.",
		getArgumentCompletions: (prefix: string) => {
			const needle = prefix.trim().toLowerCase();
			const items = needle
				? ARG_COMPLETIONS.filter((i) => i.value.toLowerCase().startsWith(needle))
				: ARG_COMPLETIONS;
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const trimmed = (await resolveCommandValue(args, ctx)).trim();
			if (!trimmed || trimmed === "status") {
				notify(
					ctx,
					`Auto-compaction context is ${enabled ? "enabled" : "disabled"}; threshold: ${thresholdPercent}%; bar: ${showBar ? "on" : "off"}`,
					"info",
				);
				return;
			}

			if (trimmed === "enable" || trimmed === "on") {
				enabled = true;
				previousPercent = null;
				pendingReason = undefined;
				notify(ctx, `Auto-compaction context enabled at ${thresholdPercent}%`, "info");
				updateStatusBar(ctx);
				return;
			}

			if (trimmed === "disable" || trimmed === "off") {
				enabled = false;
				pendingReason = undefined;
				notify(ctx, "Auto-compaction context disabled", "warning");
				updateStatusBar(ctx);
				return;
			}

			if (trimmed === "run" || trimmed === "compact") {
				triggerCompaction(ctx, "manual command");
				return;
			}

			// `bar` (toggle), `bar on`, `bar off` — control the footer progress bar.
			if (trimmed === "bar" || trimmed.startsWith("bar ")) {
				const arg = trimmed.slice(3).trim();
				const next = arg === "" ? !showBar : parseBarSetting(arg);
				if (next === undefined) {
					notify(ctx, "Usage: /auto-compact-context bar [on|off]", "warning");
					return;
				}
				showBar = next;
				notify(ctx, `Auto-compaction context bar ${showBar ? "on" : "off"}`, "info");
				updateStatusBar(ctx);
				return;
			}

			const nextThreshold = parseThreshold(trimmed);
			if (nextThreshold === undefined) {
				notify(ctx, "Usage: /auto-compact-context [status|on|off|run|bar [on|off]|<1-99 percent>]", "warning");
				return;
			}

			thresholdPercent = nextThreshold;
			previousPercent = null;
			pendingReason = undefined;
			notify(ctx, `Auto-compaction context threshold set to ${thresholdPercent}%`, "info");
			updateStatusBar(ctx);
		},
	});
}
