/**
 * Pure parsing/domain layer for the `/effort` command.
 *
 * Extracted from index.ts to isolate the (side-effect-free) argument parsing
 * and the thinking-level vocabulary from the command wiring. Keeping this layer
 * pure makes it cheap to test and reason about (cohesion + testability), while
 * index.ts stays the thin command/registration aggregator.
 *
 * Depth-one sibling module (matches the `package.json` `files` glob); imported
 * by index.ts via "./parse.js", so it is typechecked transitively.
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type EffortTarget =
	| { kind: "status" }
	| { kind: "level"; level: ThinkingLevel }
	| { kind: "ultracode" }
	| { kind: "invalid"; value: string };

/**
 * Lightweight prefix/separator words dropped before resolving the final
 * significant token (e.g. `/effort thinking=high`, `/effort level high`).
 */
const PREFIX_WORDS = ["thinking", "think", "level", "effort"];

const LEVEL_ALIASES: Record<string, ThinkingLevel> = {
	"0": "off",
	false: "off",
	no: "off",
	none: "off",
	off: "off",
	disable: "off",
	disabled: "off",
	min: "minimal",
	minimal: "minimal",
	low: "low",
	lo: "low",
	medium: "medium",
	med: "medium",
	normal: "medium",
	default: "medium",
	high: "high",
	hi: "high",
	max: "xhigh",
	xhigh: "xhigh",
	"x-high": "xhigh",
	extra: "xhigh",
};

export function parseEffortTarget(raw: string): EffortTarget {
	const value = raw.trim().toLowerCase();
	if (!value || value === "status" || value === "show" || value === "current") return { kind: "status" };
	if (value === "ultracode" || value === "ultra-code") return { kind: "ultracode" };

	// Accept `/effort thinking=high`, `/effort level high`, etc. by using the
	// final significant token after lightweight separators/prefix words.
	const tokens = value
		.replace(/[=:,]/g, " ")
		.split(/\s+/)
		.filter(Boolean)
		.filter((token) => !PREFIX_WORDS.includes(token));
	const token = tokens[tokens.length - 1] ?? value;
	const level = LEVEL_ALIASES[token];
	if (level) return { kind: "level", level };
	return { kind: "invalid", value: raw.trim() };
}
