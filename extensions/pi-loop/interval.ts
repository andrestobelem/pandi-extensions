/**
 * pi-loop interval layer (pure): parse a fixed-interval token ("5m", "30s",
 * "2h") to a clamped period in ms, and format seconds back to a human label.
 *
 * Extracted verbatim from index.ts (behavior-preserving). No ctx, no LoopState,
 * no shared mutable state — a self-contained leaf. Depth-one sibling imported by
 * index.ts via "./interval.js".
 */

// Fixed-interval bounds (seconds). The model never picks these; the user does via the
// interval token, so the only purpose is sanity (no zero / no absurdly long period).
// DELIBERATE: unlike the model-driven dynamic cadence (loop_schedule, clamped to
// [60,3600]), fixed mode is user-owned and intentionally allows sub-60s periods (e.g.
// `/loop <task> 30s`, pinned by loop-behavior tests). A too-eager cadence is bounded by
// the iteration cap, the 6h wall-clock deadline, and FIFO serialization; `0s` is rejected
// by parseInterval and falls back to the dynamic (clamped) cadence.
export const MIN_FIXED_INTERVAL_SECONDS = 1;
export const MAX_FIXED_INTERVAL_SECONDS = 24 * 60 * 60; // 24h.
export const INTERVAL_RE = /^(\d+)(s|m|h)$/;

export const INTERVAL_UNIT_MS: Record<string, number> = {
	s: 1000,
	m: 60 * 1000,
	h: 60 * 60 * 1000,
};

/**
 * Parse a fixed-interval token like "5m", "30s", "2h". Returns the period in ms,
 * clamped to [MIN_FIXED_INTERVAL_SECONDS, MAX_FIXED_INTERVAL_SECONDS], or null if
 * the token does not match ^\d+(s|m|h)$.
 */
export function parseInterval(token: string): number | null {
	const m = INTERVAL_RE.exec(token.trim());
	if (!m) return null;
	const value = Number(m[1]);
	if (!Number.isFinite(value) || value <= 0) return null;
	const unitMs = INTERVAL_UNIT_MS[m[2]];
	const rawSeconds = (value * unitMs) / 1000;
	const seconds = Math.min(
		MAX_FIXED_INTERVAL_SECONDS,
		Math.max(MIN_FIXED_INTERVAL_SECONDS, rawSeconds),
	);
	return seconds * 1000;
}

/** Human-readable interval for prompts/status (e.g. 90 -> "90s", 120 -> "2m"). */
export function formatInterval(seconds: number): string {
	if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`;
	if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
}
