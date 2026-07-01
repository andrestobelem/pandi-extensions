// pi-auto-compact footer progress bar. The bar measures progress TOWARD the
// compaction threshold (usage / threshold), so it fills to 100% exactly when
// auto-compaction is about to fire — a meaningful "how close am I" gauge rather than a
// near-empty fraction of the whole context window. Pure (no theme/ctx) so it is trivially
// unit-testable; index.ts applies color based on `level` and re-exports renderContextBar
// (+ the bar types) for the integration suite.

// Progress-bar glyphs and width.
const BAR_FILLED = "\u25B0";
const BAR_EMPTY = "\u25B1";
const BAR_WIDTH = 8;
// Below this fraction of the threshold the bar is calm (muted); at/above it the
// bar warns the user that auto-compaction is approaching.
const NEAR_RATIO = 0.6;

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
