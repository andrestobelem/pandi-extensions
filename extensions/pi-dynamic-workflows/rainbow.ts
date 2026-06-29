/**
 * Pure, dependency-free color helpers for the animated multicolor "ultracode" label.
 *
 * rainbowText() wraps each character of a string in a per-character rainbow color so the
 * caller can animate it by advancing `phase` over time. It is deterministic given (text,
 * phase, options) — no timers, no module state — so it is trivially unit/integration
 * testable; the editor owns the clock that bumps `phase` and triggers re-renders.
 *
 * Two output modes keep the effect visible across terminals: 24-bit truecolor
 * (`\x1b[38;2;r;g;bm`, e.g. iTerm2) and the 256-color cube (`\x1b[38;5;Nm`, e.g.
 * Terminal.app). detectColorMode() picks one from the environment, falling back to "none"
 * so callers can render the plain single-color label on terminals without color support.
 */

const RESET = "\x1b[0m";

export type ColorMode = "truecolor" | "ansi256" | "none";

export interface RainbowOptions {
	/** Output encoding for the per-character color. Defaults to "truecolor". */
	mode?: ColorMode;
	/** Degrees of hue between adjacent characters (the width of the rainbow band). */
	hueStep?: number;
	/** Degrees the whole band shifts per unit of `phase` (the scroll speed). */
	phaseStep?: number;
	/** HSL saturation in [0, 1]. */
	saturation?: number;
	/** HSL lightness in [0, 1]. */
	lightness?: number;
}

/** Convert an HSL color (h in degrees, s/l in [0,1]) to 8-bit RGB. */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
	const hue = ((h % 360) + 360) % 360;
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
	const m = l - c / 2;
	let r = 0;
	let g = 0;
	let b = 0;
	if (hue < 60) [r, g, b] = [c, x, 0];
	else if (hue < 120) [r, g, b] = [x, c, 0];
	else if (hue < 180) [r, g, b] = [0, c, x];
	else if (hue < 240) [r, g, b] = [0, x, c];
	else if (hue < 300) [r, g, b] = [x, 0, c];
	else [r, g, b] = [c, 0, x];
	return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** Map 8-bit RGB to the nearest color in the xterm-256 6×6×6 color cube (indices 16-231). */
export function rgbToAnsi256(r: number, g: number, b: number): number {
	const channel = (v: number) => Math.round((Math.max(0, Math.min(255, v)) / 255) * 5);
	return 16 + 36 * channel(r) + 6 * channel(g) + channel(b);
}

function colorChar(ch: string, h: number, s: number, l: number, mode: ColorMode): string {
	const [r, g, b] = hslToRgb(h, s, l);
	if (mode === "ansi256") return `\x1b[38;5;${rgbToAnsi256(r, g, b)}m${ch}${RESET}`;
	return `\x1b[38;2;${r};${g};${b}m${ch}${RESET}`;
}

/**
 * Color each non-space character of `text` along a rainbow whose phase scrolls with
 * `phase`. Spaces are emitted verbatim (no wasted escapes, invisible anyway), so the
 * visible width is unchanged. Returns `text` untouched when mode is "none".
 */
export function rainbowText(text: string, phase = 0, options: RainbowOptions = {}): string {
	const mode = options.mode ?? "truecolor";
	if (mode === "none" || text.length === 0) return text;
	const hueStep = options.hueStep ?? 18;
	const phaseStep = options.phaseStep ?? 12;
	const saturation = options.saturation ?? 1;
	const lightness = options.lightness ?? 0.6;
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === " ") {
			out += ch;
			continue;
		}
		out += colorChar(ch, phase * phaseStep + i * hueStep, saturation, lightness, mode);
	}
	return out;
}

// Control sequences to skip when matching the plain keyword: CSI (`\x1b[...m` colors and
// cursor moves), APC (`\x1b_...\x07`, which includes Pi's zero-width hardware-cursor marker),
// and other single-char escapes. They carry zero visible width and must be preserved in place.
const CONTROL_SEQUENCE = /^(?:\x1b\[[0-9;?]*[A-Za-z]|\x1b_[^\x07]*\x07|\x1b[@-Z\\-_])/;

/**
 * Recolor every visible occurrence of `keyword` (case-insensitive) inside an already-rendered
 * line with the animated rainbow, leaving all other characters and every control sequence
 * (ANSI styling + the zero-width cursor marker) exactly where they were. The visible width is
 * unchanged. Returns the line untouched when mode is "none" or the keyword is absent.
 */
export function colorizeKeyword(line: string, keyword: string, phase = 0, options: RainbowOptions = {}): string {
	const mode = options.mode ?? "truecolor";
	if (mode === "none" || !keyword || line.length === 0) return line;
	const key = keyword.toLowerCase();
	const hueStep = options.hueStep ?? 18;
	const phaseStep = options.phaseStep ?? 12;
	const saturation = options.saturation ?? 1;
	const lightness = options.lightness ?? 0.6;

	// Split the line into control tokens (kept verbatim) and visible characters, recording the
	// concatenated visible text so we can match the plain keyword across embedded escapes.
	type Token = { ctrl: true; text: string } | { ctrl: false; ch: string };
	const tokens: Token[] = [];
	let visible = "";
	for (let i = 0; i < line.length; ) {
		const match = CONTROL_SEQUENCE.exec(line.slice(i));
		if (match) {
			tokens.push({ ctrl: true, text: match[0] });
			i += match[0].length;
			continue;
		}
		tokens.push({ ctrl: false, ch: line[i] });
		visible += line[i];
		i += 1;
	}
	if (!visible.toLowerCase().includes(key)) return line;

	// Mark, for each visible character, its 0-based offset within a keyword match (or -1).
	const lower = visible.toLowerCase();
	const offsetInMatch = new Array<number>(visible.length).fill(-1);
	for (let from = lower.indexOf(key); from >= 0; from = lower.indexOf(key, from + key.length)) {
		for (let k = 0; k < key.length; k++) offsetInMatch[from + k] = k;
	}

	let out = "";
	let visibleIndex = 0;
	for (const token of tokens) {
		if (token.ctrl) {
			out += token.text;
			continue;
		}
		const offset = offsetInMatch[visibleIndex];
		out +=
			offset >= 0
				? colorChar(token.ch, phase * phaseStep + offset * hueStep, saturation, lightness, mode)
				: token.ch;
		visibleIndex += 1;
	}
	return out;
}

/** Pick the richest color encoding the current terminal advertises. */
export function detectColorMode(env: NodeJS.ProcessEnv = process.env): ColorMode {
	const colorterm = (env.COLORTERM ?? "").toLowerCase();
	if (colorterm.includes("truecolor") || colorterm.includes("24bit")) return "truecolor";
	const term = (env.TERM ?? "").toLowerCase();
	if (term.includes("truecolor") || term.includes("24bit")) return "truecolor";
	if (term.includes("256color") || term.includes("256")) return "ansi256";
	return "none";
}
