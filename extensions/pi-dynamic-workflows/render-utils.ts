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

export function padRightVisible(value: string, width: number): string {
	const maxWidth = Math.max(1, width);
	const truncated = visibleWidth(value) > maxWidth ? truncateToWidth(value, maxWidth, "") : value;
	return truncated + " ".repeat(Math.max(0, maxWidth - visibleWidth(truncated)));
}

export function stripAnsiCodes(value: string): string {
	return value
		.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
		.replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "");
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
