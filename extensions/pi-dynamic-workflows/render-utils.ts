/**
 * Pure terminal-rendering helpers for the dynamic-workflows monitor UI:
 * width-aware right padding and ANSI/control-sequence stripping. No side
 * effects and no dependency on index.ts (only the pi-tui width primitives),
 * so this is a leaf module both index.ts and the TUI components can import
 * without an ESM cycle.
 *
 * Bodies moved verbatim from index.ts (behavior-preserving).
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// This module deliberately matches terminal control/ANSI escape sequences
// (e.g. \x1b, \x07) in order to strip them. The noControlCharactersInRegex
// rule is disabled project-wide in biome.jsonc for exactly this reason.

// Render a fixed-width progress/utilization bar (e.g. "████████░░░░") for a 0..1
// fraction. Pure and width-aware: the result is ALWAYS exactly `width` glyphs so
// columns stay aligned, out-of-range / non-finite fractions clamp to [0, 1], and the
// optional `paint.fill` / `paint.empty` callbacks wrap only their own segment so the
// caller can two-tone the bar with theme colors without this leaf knowing the theme.
export function renderMeter(
	fraction: number,
	width = 12,
	paint?: { fill?: (s: string) => string; empty?: (s: string) => string },
): string {
	const safe = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
	const w = Math.max(1, Math.floor(width));
	const filled = Math.round(safe * w);
	const fill = paint?.fill ?? ((s: string) => s);
	const empty = paint?.empty ?? ((s: string) => s);
	return fill("█".repeat(filled)) + empty("░".repeat(w - filled));
}

export function padRightVisible(value: string, width: number): string {
	const maxWidth = Math.max(1, width);
	const truncated = visibleWidth(value) > maxWidth ? truncateToWidth(value, maxWidth, "") : value;
	return truncated + " ".repeat(Math.max(0, maxWidth - visibleWidth(truncated)));
}

export function stripAnsiCodes(value: string): string {
	return value.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "");
}

export function renderSafeInline(value: string): string {
	return value
		.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
		.replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\r\n\t]+/g, " ")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}
