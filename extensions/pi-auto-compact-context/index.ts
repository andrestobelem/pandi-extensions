import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	parseThreshold,
	parseBarSetting,
	parseSnapshotSetting,
	parseSnapshotKeep,
	parseClearSetting,
} from "./settings.js";
import {
	buildSnapshot,
	selectSnapshotsToPrune,
	snapshotDirFor,
	snapshotFileName,
	type CompactionSnapshot,
} from "./snapshots.js";

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

// Snapshot path/shape/prune helpers live in ./snapshots.ts. DEFAULT_SNAPSHOT_KEEP
// (used by the activate handler) bounds snapshot disk growth.
const DEFAULT_SNAPSHOT_KEEP = 20;

// Setting parsers live in ./settings.ts; re-exported here so the built bundle keeps
// exporting the public parser names (the integration suite imports them).
export { parseThreshold, parseBarSetting, parseSnapshotSetting, parseSnapshotKeep, parseClearSetting };

// Snapshot path/shape/prune helpers live in ./snapshots.ts; re-exported so the built
// bundle keeps exporting the names the integration suite imports.
export { buildSnapshot, selectSnapshotsToPrune, snapshotDirFor, snapshotFileName };
export type { CompactionSnapshot };

// Sentinel embedded in elided tool-result text. Detecting it makes clearing idempotent
// (a re-run never re-clears already-cleared text) and lets humans spot trimmed output.
export const CLEARED_SENTINEL = "[pi-auto-compact cleared";

export interface ClearToolResultsOptions {
	/** Keep the most recent N tool results fully intact (recency zone). */
	keepRecent: number;
	/** Only elide text blocks longer than this. */
	minChars: number;
	/** Characters of the original head to retain. */
	headChars: number;
	/** Characters of the original tail to retain (the "decision tail"). */
	tailChars: number;
}

// Pure, non-mutating tool-result clearing (research §3b). Returns a NEW array with the
// bulky TEXT of OLD, consumed tool results elided to head + marker + tail, or null when
// nothing changed. Preserves message identity for everything it does not touch, keeps
// toolCallId/toolName/isError and image blocks, KEEPS the last keepRecent results and
// error results (recovery signal), and is idempotent via CLEARED_SENTINEL. The caller
// applies this per LLM call only — the session retains the originals, so it is ephemeral
// and fully recoverable, never destructive.
export const clearOldToolResults = (messages: readonly unknown[], opts: ClearToolResultsOptions): unknown[] | null => {
	if (!Array.isArray(messages) || messages.length === 0) return null;
	const { keepRecent, minChars, headChars, tailChars } = opts;
	const isToolResult = (m: unknown): m is Record<string, unknown> =>
		!!m && typeof m === "object" && (m as Record<string, unknown>).role === "toolResult";

	const toolResultIdx: number[] = [];
	for (let i = 0; i < messages.length; i++) if (isToolResult(messages[i])) toolResultIdx.push(i);
	if (toolResultIdx.length === 0) return null;

	// Everything except the last keepRecent tool results is clearable.
	const clearable = toolResultIdx.slice(0, Math.max(0, toolResultIdx.length - Math.max(0, keepRecent)));
	if (clearable.length === 0) return null;
	// Never clear unless the head+tail we keep is strictly smaller than the text.
	const minEffective = Math.max(minChars, headChars + tailChars + 1);

	let changed = false;
	const out = messages.slice();
	for (const i of clearable) {
		const msg = messages[i] as Record<string, unknown>;
		if (msg.isError === true) continue; // keep failures fully (recovery signal)
		const content = msg.content;
		if (!Array.isArray(content)) continue;
		let blockChanged = false;
		const newContent = content.map((block: unknown) => {
			if (!block || typeof block !== "object") return block;
			const b = block as Record<string, unknown>;
			if (b.type !== "text" || typeof b.text !== "string") return block;
			const text = b.text;
			if (text.length <= minEffective || text.includes(CLEARED_SENTINEL)) return block;
			const head = text.slice(0, headChars);
			const tail = text.slice(text.length - tailChars);
			const removed = text.length - head.length - tail.length;
			const toolName = typeof msg.toolName === "string" ? msg.toolName : "tool";
			blockChanged = true;
			return {
				...b,
				text: `${head}\n\u2026${CLEARED_SENTINEL} ${removed} chars of this ${toolName} result to save context; the full output is preserved in the session and can be re-read]\u2026\n${tail}`,
			};
		});
		if (blockChanged) {
			out[i] = { ...msg, content: newContent };
			changed = true;
		}
	}
	return changed ? out : null;
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
	"snapshot on — keep recoverable pre-compaction snapshots",
	"snapshot off — stop keeping snapshots",
	"snapshots — list recent snapshots",
	"clear-tools on — elide old large tool outputs (cheaper than compaction)",
	"clear-tools off — stop eliding old tool outputs",
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
	{ value: "snapshot", label: "snapshot", description: "Toggle recoverable compaction snapshots" },
	{ value: "snapshot on", label: "snapshot on", description: "Keep recoverable pre-compaction snapshots" },
	{ value: "snapshot off", label: "snapshot off", description: "Stop keeping snapshots" },
	{ value: "snapshots", label: "snapshots", description: "List recent snapshots for this session" },
	{ value: "clear-tools", label: "clear-tools", description: "Toggle eliding old large tool outputs" },
	{ value: "clear-tools on", label: "clear-tools on", description: "Elide old large tool outputs per LLM call" },
	{ value: "clear-tools off", label: "clear-tools off", description: "Stop eliding old tool outputs" },
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
	// Recoverable-compaction snapshots: on by default; bounded retention per session.
	let snapshotsEnabled = parseSnapshotSetting(process.env.PI_AUTO_COMPACT_SNAPSHOT) ?? true;
	const snapshotKeep = parseSnapshotKeep(process.env.PI_AUTO_COMPACT_SNAPSHOT_KEEP) ?? DEFAULT_SNAPSHOT_KEEP;
	// Path of the snapshot written on the most recent session_before_compact, awaiting
	// its summary on session_compact. Compaction is never concurrent, so one slot suffices.
	let pendingSnapshotPath: string | undefined;
	// Tool-result clearing (research §3b): a cheaper, EPHEMERAL lever than compaction.
	// Before each LLM call, elide the bulky text of OLD consumed tool results; the session
	// keeps the originals, so it is non-destructive/recoverable. OFF by default (it changes
	// what the model sees every call); independent from the compaction trigger.
	let clearToolResults = parseClearSetting(process.env.PI_AUTO_COMPACT_CLEAR_TOOL_RESULTS) ?? false;
	// Reused positive-int parser (same semantics as the snapshot budget).
	const clearKeepRecent = parseSnapshotKeep(process.env.PI_AUTO_COMPACT_CLEAR_KEEP_RECENT) ?? 3;
	const clearMinChars = parseSnapshotKeep(process.env.PI_AUTO_COMPACT_CLEAR_MIN_CHARS) ?? 2000;
	const CLEAR_HEAD_CHARS = 200;
	const CLEAR_TAIL_CHARS = 200;

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

	// Persist the raw entries about to be summarized, BEFORE the lossy summary replaces
	// them. Fully fail-safe: any error is surfaced (UI only) and swallowed so a snapshot
	// failure can never block or cancel compaction.
	const writeCompactionSnapshot = (
		ctx: ExtensionContext,
		event: { branchEntries?: unknown[]; reason?: string; willRetry?: boolean },
	) => {
		pendingSnapshotPath = undefined;
		if (!enabled || !snapshotsEnabled) return;
		try {
			const sessionId = ctx.sessionManager?.getSessionId?.() ?? "session";
			const createdAt = new Date().toISOString();
			const reason = event.reason ?? "compact";
			const dir = snapshotDirFor(ctx.cwd, sessionId);
			const file = join(dir, snapshotFileName(createdAt, reason));
			const snapshot = buildSnapshot({
				sessionId,
				createdAt,
				reason,
				willRetry: !!event.willRetry,
				entries: Array.isArray(event.branchEntries) ? event.branchEntries : [],
			});
			mkdirSync(dir, { recursive: true });
			writeFileSync(file, JSON.stringify(snapshot, null, 2), "utf8");
			pendingSnapshotPath = file;
			// Prune oldest beyond the retention budget (the just-written file is newest).
			try {
				for (const name of selectSnapshotsToPrune(readdirSync(dir), snapshotKeep)) {
					try {
						unlinkSync(join(dir, name));
					} catch {
						/* a snapshot we could not delete is harmless; keep going */
					}
				}
			} catch {
				/* listing failed: skip pruning this round */
			}
		} catch (err) {
			pendingSnapshotPath = undefined;
			notify(ctx, `Could not save compaction snapshot: ${(err as Error).message}`, "warning");
		}
	};

	// After compaction, patch the lossy summary into the snapshot so the artifact shows
	// exactly what was dropped AND what replaced it, then surface the recoverable path.
	const finalizeCompactionSnapshot = (ctx: ExtensionContext, event: { compactionEntry?: { summary?: string } }) => {
		const file = pendingSnapshotPath;
		pendingSnapshotPath = undefined;
		if (!file) return;
		try {
			const data = JSON.parse(readFileSync(file, "utf8")) as CompactionSnapshot;
			data.summary = event.compactionEntry?.summary ?? "";
			writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
			notify(ctx, `Compaction snapshot saved (recoverable raw context): ${file}`, "info");
		} catch (err) {
			notify(ctx, `Could not finalize compaction snapshot: ${(err as Error).message}`, "warning");
		}
	};

	pi.on("session_start", (_event, ctx) => {
		updateStatusBar(ctx);
	});

	// Snapshot every compaction path (manual /compact, threshold auto-compaction, overflow
	// recovery, and this extension's own ctx.compact()). Never cancels: returns nothing.
	pi.on("session_before_compact", (event, ctx) => {
		writeCompactionSnapshot(ctx, event);
	});
	pi.on("session_compact", (event, ctx) => {
		finalizeCompactionSnapshot(ctx, event);
	});

	// Tool-result clearing runs before EACH LLM call and only affects that call's payload;
	// the session retains the originals (ephemeral + recoverable). Fail-safe: never throws,
	// returns nothing when disabled or when no message changed.
	pi.on("context", (event) => {
		if (!clearToolResults) return;
		try {
			const next = clearOldToolResults(event.messages, {
				keepRecent: clearKeepRecent,
				minChars: clearMinChars,
				headChars: CLEAR_HEAD_CHARS,
				tailChars: CLEAR_TAIL_CHARS,
			});
			if (next) return { messages: next as typeof event.messages };
		} catch {
			/* fail-safe: leave the context unchanged */
		}
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
					`Auto-compaction context is ${enabled ? "enabled" : "disabled"}; threshold: ${thresholdPercent}%; bar: ${showBar ? "on" : "off"}; snapshots: ${snapshotsEnabled ? "on" : "off"} (keep ${snapshotKeep}); clear-tools: ${clearToolResults ? "on" : "off"} (keep ${clearKeepRecent}, >=${clearMinChars} chars)`,
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
				const arg = trimmed.slice("bar ".length).trim();
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

			// `snapshots` — list recent recoverable snapshots for this session (read-only).
			if (trimmed === "snapshots") {
				try {
					const dir = snapshotDirFor(ctx.cwd, ctx.sessionManager?.getSessionId?.() ?? "session");
					const files = existsSync(dir)
						? readdirSync(dir)
								.filter((n) => n.endsWith(".json"))
								.sort()
								.reverse()
						: [];
					if (files.length === 0) {
						notify(ctx, `No compaction snapshots yet (${dir})`, "info");
					} else {
						const top = files.slice(0, 10).map((n) => join(dir, n));
						notify(ctx, `Recent compaction snapshots:\n${top.join("\n")}`, "info");
					}
				} catch (err) {
					notify(ctx, `Could not list snapshots: ${(err as Error).message}`, "warning");
				}
				return;
			}

			// `snapshot` (toggle), `snapshot on`, `snapshot off` — recoverable-compaction snapshots.
			if (trimmed === "snapshot" || trimmed.startsWith("snapshot ")) {
				const arg = trimmed.slice("snapshot".length).trim();
				const next = arg === "" ? !snapshotsEnabled : parseSnapshotSetting(arg);
				if (next === undefined) {
					notify(ctx, "Usage: /auto-compact-context snapshot [on|off]", "warning");
					return;
				}
				snapshotsEnabled = next;
				notify(ctx, `Auto-compaction context snapshots ${snapshotsEnabled ? "on" : "off"}`, "info");
				return;
			}

			// `clear-tools` (toggle), `clear-tools on`, `clear-tools off` — elide old tool outputs.
			if (trimmed === "clear-tools" || trimmed.startsWith("clear-tools ")) {
				const arg = trimmed.slice("clear-tools".length).trim();
				const next = arg === "" ? !clearToolResults : parseClearSetting(arg);
				if (next === undefined) {
					notify(ctx, "Usage: /auto-compact-context clear-tools [on|off]", "warning");
					return;
				}
				clearToolResults = next;
				notify(ctx, `Auto-compaction context tool-result clearing ${clearToolResults ? "on" : "off"}`, "info");
				return;
			}

			const nextThreshold = parseThreshold(trimmed);
			if (nextThreshold === undefined) {
				notify(
					ctx,
					"Usage: /auto-compact-context [status|on|off|run|bar [on|off]|snapshot [on|off]|snapshots|clear-tools [on|off]|<1-99 percent>]",
					"warning",
				);
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
