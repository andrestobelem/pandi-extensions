/**
 * compaction-progress — Standalone Pi extension.
 *
 * Shows a progress bar while Pi compacts (summarizes) the conversation context,
 * which happens when the context approaches the model's window and Pi must
 * resume/compact to keep going.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * FEASIBILITY (verified against the installed SDK — symbols cited file:line)
 * ──────────────────────────────────────────────────────────────────────────
 * (a) IS THERE A START/END HOOK?  YES.
 *     The extension event surface (`pi.on(...)`) exposes a compaction
 *     START and END pair:
 *       - "session_before_compact" — fired BEFORE compaction. Carries
 *         `reason: "manual" | "threshold" | "overflow"`, a `preparation`
 *         (CompactionPreparation incl. `tokensBefore`), `willRetry`, and an
 *         AbortSignal. Source:
 *         node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:424-435
 *         registered at types.d.ts:822.
 *       - "session_compact" — fired AFTER compaction. Carries
 *         `compactionEntry` (CompactionEntry incl. `summary`, `tokensBefore`),
 *         `reason`, `willRetry`. Source: types.d.ts:436-445, registered at
 *         types.d.ts:823.
 *
 *     NOTE / CORRECTION: there is ALSO a lower-level `compaction_start` /
 *     `compaction_end` pair, but those are `AgentSessionEvent`s
 *     (agent-session.d.ts:51-77), NOT part of the `pi.on(...)` extension API.
 *     They are NOT subscribable from an extension. The subscribable pair is
 *     `session_before_compact` / `session_compact`. We use those.
 *
 * (b) DOES IT REPORT PROGRESS (percent / phase) OR ONLY START/END?
 *     ONLY START/END. Compaction is a single LLM summarization call
 *     (compaction.d.ts:91-95 `generateSummary`) with no intermediate progress
 *     events. There is no percent or phase callback. Therefore the bar is
 *     INDETERMINATE: an animated sweep shown from start until end. On end we
 *     briefly show a deterministic result (token delta) then clear.
 *
 * (c) UI PRIMITIVE FOR THE BAR.
 *     There is NO native progress-bar component. We render it manually.
 *       - `ctx.ui.setWidget(key, factory, {placement})` — live widget; the
 *         factory `(tui, theme) => { invalidate(); render(width): string[] }`
 *         is the only refreshable surface (types.d.ts:97-99). We push a new
 *         frame each tick by calling setWidget again (same pattern as the
 *         dashboard live view in extensions/dynamic-workflows.ts:2107-2116 +
 *         setInterval at :3863). Used in `tui` mode for the animated sweep.
 *       - `ctx.ui.setStatus(key, text)` — footer one-liner (types.d.ts:79).
 *         Used as a lightweight indicator in `rpc` mode (no animation) and
 *         alongside the widget in tui.
 *       - `ctx.ui.theme.fg(color, text)` colorizes (theme.d.ts:18). Colors
 *         used: accent, success, error, dim, warning, muted (theme.d.ts:3).
 *     We can read `ctx.getContextUsage()` (types.d.ts:236, ContextUsage at
 *     types.d.ts:192-198) for the "after" token count.
 *
 * (d) DOES IT REQUIRE TUI?
 *     `ctx.hasUI` (types.d.ts:214) is true in tui + rpc, false in json/print.
 *     `ctx.mode` (types.d.ts:212) discriminates. We gate ALL UI behind
 *     `ctx.hasUI` (so json/print show nothing) and only ANIMATE the widget in
 *     `mode === "tui"`; in `rpc` we use a static status line.
 *
 * Design summary: hook session_before_compact -> show indeterminate animated
 * bar; hook session_compact -> show final token delta for a short hold then
 * clear; hook session_shutdown -> stop the timer and clear all UI (no dangling
 * timers). A `/compaction-progress on|off|status` command toggles it (default
 * ON). Standalone: imports only the Pi SDK; touches no other extension and no
 * package.json.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";

const WIDGET_KEY = "compaction-progress:bar";
const STATUS_KEY = "compaction-progress:status";

/** Width of the indeterminate bar track, in cells. */
const BAR_WIDTH = 24;
/** Animation tick interval (ms). */
const TICK_MS = 120;
/** How long to keep the "done" summary visible before clearing (ms). */
const DONE_HOLD_MS = 2500;

type CompactionReason = "manual" | "threshold" | "overflow";

interface ActiveCompaction {
	reason: CompactionReason;
	startedAt: number;
	/** Tokens before compaction, if known from the event. */
	tokensBefore?: number;
	/** Animation frame counter. */
	frame: number;
}

export default function compactionProgressExtension(pi: ExtensionAPI): void {
	// Module-scoped state lives in the factory closure (one per extension load).
	let enabled = true;
	let active: ActiveCompaction | undefined;
	let animTimer: ReturnType<typeof setInterval> | undefined;
	let doneTimer: ReturnType<typeof setTimeout> | undefined;
	/** Last ctx seen from an event — used by timers to push frames / clean up. */
	let lastCtx: ExtensionContext | undefined;

	function stopAnimTimer(): void {
		if (animTimer !== undefined) {
			clearInterval(animTimer);
			animTimer = undefined;
		}
	}

	function stopDoneTimer(): void {
		if (doneTimer !== undefined) {
			clearTimeout(doneTimer);
			doneTimer = undefined;
		}
	}

	/** Tear down every timer and clear all UI. Safe to call repeatedly. */
	function clearAll(ctx: ExtensionContext | undefined): void {
		stopAnimTimer();
		stopDoneTimer();
		active = undefined;
		if (ctx && ctx.hasUI) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	}

	/** Build the indeterminate animated bar lines (tui) for the current frame. */
	function renderRunningLines(ctx: ExtensionContext, width: number): string[] {
		const theme = ctx.ui.theme;
		const a = active;
		const reason = a ? a.reason : "threshold";
		const frame = a ? a.frame : 0;

		// Indeterminate sweep: a lit window of fixed size slides back and forth
		// across the track. No real progress exists, so we never imply a percent.
		const windowSize = 6;
		const span = BAR_WIDTH - windowSize;
		// Triangle wave so the window bounces instead of jumping at the edges.
		const cycle = span * 2;
		const pos = span <= 0 ? 0 : (() => {
			const m = frame % cycle;
			return m <= span ? m : cycle - m;
		})();

		let bar = "";
		for (let i = 0; i < BAR_WIDTH; i++) {
			bar += i >= pos && i < pos + windowSize ? "█" : "░";
		}

		const elapsed = a ? Math.max(0, Math.round((Date.now() - a.startedAt) / 1000)) : 0;
		const reasonLabel = compactionReasonLabel(reason);
		const head = theme.fg("accent", "⟳ Compacting context");
		const track = theme.fg("accent", bar);
		const meta = theme.fg("dim", `${reasonLabel} • ${elapsed}s`);

		const full = `${head} ${track} ${meta}`;
		return [clipLine(full, width)];
	}

	/** Build the deterministic "done" line shown briefly after compaction. */
	function renderDoneLines(
		ctx: ExtensionContext,
		reason: CompactionReason,
		tokensBefore: number | undefined,
		tokensAfter: number | undefined,
		width: number,
	): string[] {
		const theme = ctx.ui.theme;
		const filled = theme.fg("success", "█".repeat(BAR_WIDTH));
		const delta = formatTokenDelta(tokensBefore, tokensAfter);
		const head = theme.fg("success", "✓ Context compacted");
		const meta = theme.fg("dim", `${compactionReasonLabel(reason)}${delta ? ` • ${delta}` : ""}`);
		return [clipLine(`${head} ${theme.fg("success", filled)} ${meta}`, width)];
	}

	/** Push the current running frame to the UI (widget in tui, status elsewhere). */
	function showRunning(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (ctx.mode === "tui") {
			// Re-set the widget each tick to force a redraw with the new frame.
			ctx.ui.setWidget(
				WIDGET_KEY,
				() => ({
					invalidate(): void {},
					render(width: number): string[] {
						return renderRunningLines(ctx, width);
					},
				}),
				{ placement: "belowEditor" },
			);
		}
		// Footer status works in tui and rpc; gives rpc a (static) indicator.
		const reason = active ? compactionReasonLabel(active.reason) : "auto";
		ctx.ui.setStatus(
			STATUS_KEY,
			`${ctx.ui.theme.fg("accent", "⟳ compacting")} ${ctx.ui.theme.fg("dim", reason)}`,
		);
	}

	function showDone(
		ctx: ExtensionContext,
		reason: CompactionReason,
		tokensBefore: number | undefined,
		tokensAfter: number | undefined,
	): void {
		if (!ctx.hasUI) return;
		if (ctx.mode === "tui") {
			ctx.ui.setWidget(
				WIDGET_KEY,
				() => ({
					invalidate(): void {},
					render(width: number): string[] {
						return renderDoneLines(ctx, reason, tokensBefore, tokensAfter, width);
					},
				}),
				{ placement: "belowEditor" },
			);
		}
		const delta = formatTokenDelta(tokensBefore, tokensAfter);
		ctx.ui.setStatus(
			STATUS_KEY,
			`${ctx.ui.theme.fg("success", "✓ compacted")}${delta ? ` ${ctx.ui.theme.fg("dim", delta)}` : ""}`,
		);
	}

	// ── START: session_before_compact ──────────────────────────────────────
	pi.on("session_before_compact", (event: SessionBeforeCompactEvent, ctx) => {
		lastCtx = ctx;
		if (!enabled || !ctx.hasUI) return;
		// A new compaction supersedes any lingering "done" hold.
		stopDoneTimer();
		stopAnimTimer();
		active = {
			reason: event.reason,
			startedAt: Date.now(),
			tokensBefore: event.preparation?.tokensBefore,
			frame: 0,
		};
		showRunning(ctx);
		if (ctx.mode === "tui") {
			animTimer = setInterval(() => {
				if (!active || !lastCtx) return;
				active.frame += 1;
				showRunning(lastCtx);
			}, TICK_MS);
		}
		// No return value: this is an observational hook only; we do not
		// cancel or replace the compaction.
	});

	// ── END: session_compact ────────────────────────────────────────────────
	pi.on("session_compact", (event: SessionCompactEvent, ctx) => {
		lastCtx = ctx;
		stopAnimTimer();
		if (!enabled || !ctx.hasUI) {
			clearAll(ctx);
			return;
		}
		const reason = event.reason;
		const tokensBefore = event.compactionEntry?.tokensBefore ?? active?.tokensBefore;
		// "after" isn't carried by the event; read live usage. It may be null
		// right after compaction (ContextUsage.tokens doc, types.d.ts:193),
		// in which case we just show the "before" figure.
		const usage = ctx.getContextUsage();
		const tokensAfter = usage && usage.tokens != null ? usage.tokens : undefined;
		active = undefined;
		showDone(ctx, reason, tokensBefore, tokensAfter);
		stopDoneTimer();
		doneTimer = setTimeout(() => {
			doneTimer = undefined;
			clearAll(lastCtx);
		}, DONE_HOLD_MS);
	});

	// ── CLEANUP: session_shutdown — never leave a timer or widget behind. ────
	pi.on("session_shutdown", (_event, ctx) => {
		lastCtx = ctx;
		clearAll(ctx);
	});

	// ── Optional toggle command (default ON). ────────────────────────────────
	pi.registerCommand("compaction-progress", {
		description: "Show/hide the compaction progress bar: /compaction-progress [on|off|status]",
		handler: async (args, ctx) => {
			const value = args.trim().toLowerCase();
			if (!value || value === "status") {
				notify(ctx, `Compaction progress bar is ${enabled ? "on" : "off"}.`, "info");
				return;
			}
			if (["on", "enable", "enabled", "true", "1"].includes(value)) {
				enabled = true;
				notify(ctx, "Compaction progress bar enabled.", "info");
				return;
			}
			if (["off", "disable", "disabled", "false", "0"].includes(value)) {
				enabled = false;
				clearAll(ctx);
				notify(ctx, "Compaction progress bar disabled.", "warning");
				return;
			}
			notify(ctx, "Usage: /compaction-progress [on|off|status]", "warning");
		},
	});
}

function compactionReasonLabel(reason: CompactionReason): string {
	switch (reason) {
		case "manual":
			return "manual /compact";
		case "overflow":
			return "context overflow";
		case "threshold":
		default:
			return "context threshold";
	}
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}

function formatTokenDelta(before: number | undefined, after: number | undefined): string {
	if (before != null && after != null) return `${formatTokens(before)} → ${formatTokens(after)} tokens`;
	if (before != null) return `was ${formatTokens(before)} tokens`;
	return "";
}

/** Clip a (possibly ANSI-colored) line so it never exceeds the widget width. */
function clipLine(line: string, width: number): string {
	if (!Number.isFinite(width) || width <= 0) return line;
	// Count only visible chars (skip ANSI escape sequences) so colored text
	// isn't truncated mid-escape and the visible length respects `width`.
	let visible = 0;
	let out = "";
	let i = 0;
	while (i < line.length) {
		const ch = line[i]!;
		if (ch === "") {
			// Copy the whole escape sequence (ESC [ ... letter) without counting it.
			const start = i;
			i++;
			if (line[i] === "[") {
				i++;
				while (i < line.length && !/[A-Za-z]/.test(line[i]!)) i++;
				if (i < line.length) i++; // include final letter
			}
			out += line.slice(start, i);
			continue;
		}
		if (visible >= width) {
			// Drop remaining visible chars but keep trailing resets handled by caller.
			break;
		}
		out += ch;
		visible++;
		i++;
	}
	return out;
}

function notify(
	ctx: ExtensionContext,
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	if (ctx.mode === "print") return;
	if (ctx.hasUI) ctx.ui.notify(message, type);
}
