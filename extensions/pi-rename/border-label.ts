/**
 * Pure helpers to embed a right-aligned label into the editor's top border (the violet
 * prompt line), mirroring how the dynamic-workflows editor shows "ultracode auto".
 *
 * No imports: a small vendored ANSI stripper and a length-based width are enough for the
 * ASCII slugs + a couple of symbols we render. composeTopBorder() is deterministic and
 * unit-tested; index.ts owns the (impure) editor wrapping.
 */

const ANSI = /\x1b\[[0-9;]*m/g;
const DASH = "─";

export function stripAnsi(value: string): string {
	return value.replace(ANSI, "");
}

export function visibleWidth(value: string): number {
	return stripAnsi(value).length;
}

export interface ComposeDeps {
	/** Wrap the rebuilt line in the editor's border color (defaults to identity). */
	color?: (value: string) => string;
}

/**
 * Right-align ` <label> ` into a top-border line, preserving any existing right-aligned
 * label (e.g. "ultracode auto") as ` <label> · <existing> `. Returns the rebuilt line,
 * or null when the line is not a decoratable border — a left-aligned hint such as a
 * scroll indicator ("↑ N more") or anything that does not parse as a border is left
 * untouched, and null is returned when there is not enough room.
 */
export function composeTopBorder(line0: string, width: number, label: string, deps: ComposeDeps = {}): string | null {
	if (!line0 || width <= 0 || !label) return null;
	const color = deps.color ?? ((value: string) => value);
	const plain = stripAnsi(line0);

	let existing = "";
	if (!/^─+$/.test(plain)) {
		const match = plain.match(/^(─+) (.+) (─+)$/);
		if (!match) return null; // not a recognizable border line
		const leftDashes = match[1].length;
		const rightDashes = match[3].length;
		// A right-aligned label (e.g. ultracode) has few trailing dashes; a left-aligned
		// hint (e.g. "↑ N more") has many. Only combine with a right-aligned label.
		if (rightDashes > leftDashes) return null;
		existing = match[2].trim();
	}

	const combined = existing ? `${label} · ${existing}` : label;
	const text = ` ${combined} `;
	const rightDashes = 2;
	const leftDashes = width - visibleWidth(text) - rightDashes;
	if (leftDashes < 2) return null;
	return color(DASH.repeat(leftDashes) + text + DASH.repeat(rightDashes));
}
