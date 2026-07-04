/**
 * Pure panda-face block-art + theme-adaptive palette for Pandi's splash. No SDK, no I/O,
 * no randomness at module load: importing this file is side-effect free, so it can be unit
 * tested in isolation (index.ts is the only orchestration layer).
 *
 * Why a palette instead of fixed black/white: the face is two tones — ░ (the light face)
 * and █ (the dark patches: ears, eyes, nose). A single fixed black/white palette breaks in
 * one mode — the dark patches vanish on a dark terminal, and the light face vanishes on a
 * light terminal. So the palette ADAPTS to the terminal mode: each tone is nudged off the
 * background it would otherwise blend into, while keeping strong internal face/patch
 * contrast so Pandi always reads as a panda.
 */

export type TerminalMode = "dark" | "light";

/** An 8-bit RGB triple. */
export type Rgb = readonly [number, number, number];

/** The panda face in block-art. ░ = light face, █ = dark patch. Spaces are transparent. */
export const PANDA_FACE = [
	"████    ████",
	"░░░░░░░░░░░░░░░░",
	"░░████░░░░████░░",
	"░░░░░░████░░░░░░",
	"░░░░░░░░░░░░░░░░",
	"██░░░░░░░░░░░░██",
	"██░░░░░░░░░░░░██",
	"  ░░░░░░░░░░░░  ",
	"  ████    ████",
] as const;

/** Width of the widest face row (for padding the splash into a clean column). */
export const FACE_WIDTH = Math.max(...PANDA_FACE.map((line) => [...line].length));

/** The two tones used to paint the face for a given terminal mode. */
export interface PandaPalette {
	/** Color for ░ — the panda's light face. */
	face: Rgb;
	/** Color for █ — the panda's dark patches (ears, eyes, nose). */
	patch: Rgb;
}

/**
 * Pick the face/patch tones for a terminal mode.
 * - dark mode: face stays bright white; the patch is lifted off pure black so it survives a
 *   dark background.
 * - light mode: the patch is near-black so it shows; the face is pulled down off pure white
 *   so it stays distinct from a light background.
 */
export function pandaPalette(mode: TerminalMode): PandaPalette {
	return mode === "light"
		? { face: [165, 167, 173], patch: [28, 30, 34] }
		: { face: [237, 237, 232], patch: [70, 74, 82] };
}

/** Blend an RGB triple toward black (t<1) or white via `blendTo`; each channel rounded + clamped. */
function blend([r, g, b]: Rgb, target: number, t: number): Rgb {
	const mix = (c: number) => Math.max(0, Math.min(255, Math.round(c + (target - c) * t)));
	return [mix(r), mix(g), mix(b)];
}

/**
 * Derive Pandi's two tones from the THEME's ink (the `text` color). Themes expose no explicit
 * black/white role, so we use the ONE extreme the theme gives us — its ink — for the tone that
 * matches the mode, and derive the opposite tone by blending that same ink (preserving its hue,
 * so a tinted theme yields a tinted-but-monochrome panda):
 * - dark theme (light ink): face = the ink itself (the theme's white); patch = ink blended 70%
 *   toward black (a dark, same-hue version that survives a dark background).
 * - light theme (dark ink): patch = the ink itself (the theme's black); face = ink blended 60%
 *   toward white (a light, same-hue version distinct from a light background).
 * The mode threshold (text luminance ≥ 0.5 ⇒ dark) guarantees ≥ 0.3 face/patch contrast either way.
 */
export function pandaPaletteFromInk(ink: Rgb, mode: TerminalMode): PandaPalette {
	return mode === "light"
		? { face: blend(ink, 255, 0.6), patch: [ink[0], ink[1], ink[2]] }
		: { face: [ink[0], ink[1], ink[2]], patch: blend(ink, 0, 0.7) };
}

const RESET = "\x1b[0m";

/** Build a truecolor foreground SGR escape for an RGB triple. */
export const fgAnsi = ([r, g, b]: Rgb): string => `\x1b[38;2;${r};${g};${b}m`;

/** Naranja-coral de Anthropic/Claude — el color del ◆ que es el "ADN de Claude". */
export const CLAUDE_ORANGE: Rgb = [217, 119, 87];

/**
 * Pinta un glifo de "ojo" en el escape de color DADO y resetea el color después, para que
 * las caritas BRILLEN sin ser de un tono plano. El color lo elige el orquestador desde la
 * paleta del tema (theme.getFgAnsi(rol)) — no hay color hardcodeado acá. Preserva glifos
 * con acento combinante (p. ej. "•̀").
 */
export const glintEye = (glyph: string, fg: string): string => `${fg}${glyph}${RESET}`;

/**
 * Rol de color de la PALETA DEL TEMA para los ojos de cada carita (theme-adaptive), elegido
 * semánticamente: happy=success (verde), error=error (rojo), el resto=accent. Son nombres de
 * `ThemeColor` válidos; el orquestador los resuelve con theme.getFgAnsi(rol). Se mantiene
 * SDK-free (as const) para que este módulo siga siendo puro y testeable en aislamiento.
 */
export const FACE_EYE_ROLE = {
	thinking: "accent",
	happy: "success",
	error: "error",
	basico: "accent",
	gatuno: "accent",
} as const;

/**
 * Estilos del indicador animado, EN ORDEN DE CICLADO: `/pandi face` avanza al siguiente y
 * envuelve al final. El orquestador (index.ts) mapea cada uno a sus frames.
 */
export const FACE_STYLES = ["claude", "kaomoji", "ojitos", "decidido", "gatuno"] as const;

/** El estilo de carita del indicador. */
export type FaceStyle = (typeof FACE_STYLES)[number];

/** Valida un estilo persistido (viene de JSON de disco); default "claude" si no matchea. */
export function parseFaceStyle(raw: unknown): FaceStyle {
	return FACE_STYLES.includes(raw as FaceStyle) ? (raw as FaceStyle) : "claude";
}

/** El siguiente estilo en el ciclo, con wrap-around al principio. */
export function nextFaceStyle(current: FaceStyle): FaceStyle {
	const i = FACE_STYLES.indexOf(current);
	return FACE_STYLES[(i + 1) % FACE_STYLES.length];
}

/**
 * Paint one face row: █→patch block, ░→face block (both as solid █ so the face is opaque),
 * spaces left transparent. Each ink cell is reset so colors never bleed.
 */
export function colorizeFace(line: string, palette: PandaPalette): string {
	const patch = fgAnsi(palette.patch);
	const face = fgAnsi(palette.face);
	let out = "";
	for (const ch of line) {
		if (ch === "█") out += `${patch}█${RESET}`;
		else if (ch === "░") out += `${face}█${RESET}`;
		else out += " ";
	}
	return out;
}

/** Parse a truecolor fg SGR escape (`38;2;r;g;b`) into RGB; undefined for anything else. */
export function parseFgRgb(ansi: string): Rgb | undefined {
	const m = /38;2;(\d+);(\d+);(\d+)/.exec(ansi);
	if (!m) return undefined;
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Relative luminance in [0, 1] (Rec. 709 weights), used to compare tones. */
export function luminance([r, g, b]: Rgb): number {
	return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Infer the terminal mode from the theme's primary text color: a light theme uses dark
 * text and a dark theme uses light text, so bright text => dark mode. Falls back when the
 * text color is not a parseable truecolor escape (e.g. a 256-color theme).
 */
export function modeFromTextColor(textAnsi: string, fallback: TerminalMode = "dark"): TerminalMode {
	const rgb = parseFgRgb(textAnsi);
	if (!rgb) return fallback;
	return luminance(rgb) >= 0.5 ? "dark" : "light";
}
