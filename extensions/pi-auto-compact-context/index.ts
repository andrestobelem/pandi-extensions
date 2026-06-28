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

		const crossedThreshold = previousPercent === undefined || previousPercent === null || previousPercent < thresholdPercent;
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
		description: "Show, enable/disable, set, toggle the footer progress bar, or manually trigger relative context auto-compaction (default enabled at 30%)",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
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
