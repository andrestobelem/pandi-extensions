/**
 * pandi-typescript-lsp settings: the small, pure setting parsers (env + subcommand
 * share these — mirrors pandi-auto-compact) plus the feedback-mode/scope
 * value types they produce.
 *
 * Like diagnostics.ts, this module is deliberately free of pi's ExtensionContext
 * / UI so it can be unit-tested in isolation against the same bundle the
 * extension ships. No side effects.
 *
 * Depth-one sibling module imported by index.ts via "./settings.js".
 */

export type FeedbackMode = "advisory" | "autofix";
export type Scope = "touched" | "project";

/** Parse an on/off-style setting. Returns undefined for unrecognised input. */
export function parseOnOff(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const v = value.trim().toLowerCase();
	if (v === "on" || v === "1" || v === "true" || v === "yes") return true;
	if (v === "off" || v === "0" || v === "false" || v === "no") return false;
	return undefined;
}

/** Parse the feedback mode setting (advisory | autofix). */
export function parseMode(value: string | undefined): FeedbackMode | undefined {
	if (value === undefined) return undefined;
	const v = value.trim().toLowerCase();
	if (v === "advisory" || v === "autofix") return v;
	return undefined;
}

/** Parse a positive integer max-errors setting. */
export function parseMax(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const n = Number(value.trim());
	if (!Number.isInteger(n) || n <= 0) return undefined;
	return n;
}

/** Parse a scope setting (touched | project). */
export function parseScope(value: string | undefined): Scope | undefined {
	if (value === undefined) return undefined;
	const v = value.trim().toLowerCase();
	if (v === "touched" || v === "project") return v;
	return undefined;
}
