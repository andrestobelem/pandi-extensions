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
	/** Wrap dashes (and any existing label) in the editor's border color. Default: identity. */
	color?: (value: string) => string;
	/** Style the name label itself, e.g. inverted fg/bg "pill". Default: same as color. */
	labelColor?: (value: string) => string;
}

/**
 * Right-align the name label into a top-border line. Any existing right-aligned label
 * (e.g. "ultracode auto") is kept and placed FIRST, with the name last, joined by the
 * border glyph so the line continues into the name pill. The name is styled with
 * labelColor (its own pill), the rest
 * with color. Returns the rebuilt line, or null when the line is not a decoratable border
 * — a left-aligned hint such as a scroll indicator ("↑ N more") or anything that does not
 * parse as a border is left untouched, and null is returned when there is not enough room.
 */
export function composeTopBorder(line0: string, width: number, label: string, deps: ComposeDeps = {}): string | null {
	if (!line0 || width <= 0 || !label) return null;
	const color = deps.color ?? ((value: string) => value);
	const labelColor = deps.labelColor ?? color;
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

	// Connect the existing label to the name with the SAME border glyph (─), so the line
	// continues seamlessly into the name pill instead of a spaced ASCII separator.
	const pill = ` ${label} `;
	const joiner = ` ${DASH}${DASH}`;
	const visibleMiddle = existing ? ` ${existing}${joiner}${pill}` : pill;
	const styledMiddle = existing ? color(` ${existing}${joiner}`) + labelColor(pill) : labelColor(pill);

	const rightDashes = 2;
	const leftDashes = width - visibleWidth(visibleMiddle) - rightDashes;
	if (leftDashes < 2) return null;
	return color(DASH.repeat(leftDashes)) + styledMiddle + color(DASH.repeat(rightDashes));
}
