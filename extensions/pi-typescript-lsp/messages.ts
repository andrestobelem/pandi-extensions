import { type FormatResult } from "./diagnostics.js";

/** Build the advisory feedback body (non-blocking, surfaced next turn). */
export function advisoryMessage(formatted: FormatResult): string {
	return [
		"TypeScript diagnostics on the files you just changed:",
		"",
		formatted.text,
		"",
		"Fix these when you continue; run typescript_diagnostics to re-check.",
	].join("\n");
}

/** Build the autofix follow-up body (triggers a turn so the agent fixes them). */
export function autofixMessage(formatted: FormatResult): string {
	return [
		"TypeScript diagnostics were found on the files you just changed:",
		"",
		formatted.text,
		"",
		"Fix these type errors now, then re-run typescript_diagnostics to confirm a clean result.",
	].join("\n");
}
