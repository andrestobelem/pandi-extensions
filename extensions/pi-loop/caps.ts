/**
 * pi-loop caps policy (pure). Decides whether a loop has hit a HARD cap (absolute
 * wall-clock deadline) or a best-effort budget cap (context-usage percent),
 * returning a human-readable stop-reason or undefined. No shared state, no FIFO,
 * no side effects — the scheduler (fireWake / drainWakeQueue / rehydrate / agent_end)
 * imports this and owns the imperative stop. Extracted from index.ts with the body
 * verbatim; only the loop parameter is decoupled from ActiveLoop into a structural
 * LoopCapsInput. Depth-one sibling imported via "./caps.js".
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Structural subset of the loop state that capExceeded reads. ActiveLoop satisfies it. */
export interface LoopCapsInput {
	startedAt: number;
	maxWallClockMs: number;
	contextPercentCap: number;
}

/**
 * Caps gate (P1). Returns a stop-reason string if a hard cap (wall-clock deadline)
 * or a best-effort budget cap (context-usage percent) is exceeded, else undefined.
 * Checked BEFORE re-arming so a loop never schedules another iteration past a cap.
 * maxIterations stays a separate gate inside fireWake (unchanged from P0).
 */
export function capExceeded(ctx: ExtensionContext, loop: LoopCapsInput): string | undefined {
	const elapsed = Date.now() - loop.startedAt;
	if (loop.maxWallClockMs > 0 && elapsed >= loop.maxWallClockMs) {
		return `reached wall-clock deadline (${Math.round(loop.maxWallClockMs / 60000)}m)`;
	}
	// Best-effort: getContextUsage may be unavailable (undefined) or unknown (percent null).
	const usage = ctx.getContextUsage?.();
	if (usage && usage.percent !== null && usage.percent >= loop.contextPercentCap) {
		return `reached context budget (${Math.round(usage.percent)}% ≥ ${loop.contextPercentCap}%)`;
	}
	return undefined;
}
