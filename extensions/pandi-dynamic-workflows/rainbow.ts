/**
 * Ayudantes de color puros, sin dependencias, para la etiqueta "ultracode" animada multicolor.
 *
 * rainbowText() envuelve cada carácter de un string en un color rainbow per-carácter así el
 * llamador puede animarlo avanzando `phase` con el tiempo. Es determinístico dado (text, phase,
 * options) — sin timers, sin module state — así es trivialmente testeable unit/integration;
 * el editor es dueño del reloj que incrementa `phase` y desencadena re-renders.
 *
 * Dos modos de output mantienen el efecto visible entre terminales: 24-bit truecolor
 * (`\x1b[38;2;r;g;bm`, p. ej. iTerm2) y el cubo 256-color (`\x1b[38;5;Nm`, p. ej.
 * Terminal.app). detectColorMode() elige uno del environment, fallando a "none" así
 * llamadores pueden renderizar la etiqueta plain single-color en terminales sin soporte color.
 */

const RESET = "\x1b[0m";

export type ColorMode = "truecolor" | "ansi256" | "none";

export interface RainbowOptions {
	/** Encoding de output para el color per-carácter. Default a "truecolor". */
	mode?: ColorMode;
	/** Grados de hue entre caracteres adyacentes (el ancho de la banda rainbow). */
	hueStep?: number;
	/** Grados que toda la banda se desplaza por unidad de `phase` (la velocidad de scroll). */
	phaseStep?: number;
	/** Saturación HSL en [0, 1]. */
	saturation?: number;
	/** Luminosidad HSL en [0, 1]. */
	lightness?: number;
}

/** Convierte un color HSL (h en grados, s/l en [0,1]) a RGB 8-bit. */
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

// Secuencias de control a saltar cuando se matchea la palabra clave plain: CSI (`\x1b[...m`
// colores y cursor moves), APC (`\x1b_...\x07`, que incluye el marcador hardware-cursor
// zero-width de Pi), y otros single-char escapes. Llevan zero visible width y deben
// preservarse en lugar.
const CONTROL_SEQUENCE = /^(?:\x1b\[[0-9;?]*[A-Za-z]|\x1b_[^\x07]*\x07|\x1b[@-Z\\-_])/;

// Una palabra clave solo cuenta como un trigger token standalone: limitada a la IZQUIERDA por
// start-of-text, un space, o una `/` (así `/ultracode` y ` ultracode ` cuentan) y a la DERECHA
// por end-of-text o space. Substrings pegados a palabra más grande (`workflows`, `myultracode`)
// NO son tokens.
const isKeywordLeftBoundary = (text: string, at: number): boolean =>
	at === 0 || text[at - 1] === " " || text[at - 1] === "/";
const isKeywordRightBoundary = (text: string, at: number): boolean => at === text.length || text[at] === " ";

/**
 * Verdadero cuando `text` contiene `keyword` (case-insensitive) como token standalone por la
 * regla boundary arriba. Substrings dentro de palabras más grandes no cuentan.
 */
export function containsKeywordToken(text: string, keyword: string): boolean {
	if (!keyword) return false;
	const lower = text.toLowerCase();
	const key = keyword.toLowerCase();
	for (let from = lower.indexOf(key); from >= 0; from = lower.indexOf(key, from + 1)) {
		if (isKeywordLeftBoundary(lower, from) && isKeywordRightBoundary(lower, from + key.length)) return true;
	}
	return false;
}

/**
 * Recolorea cada ocurrencia visible de `keyword` (case-insensitive) dentro de una línea ya
 * renderizada con el rainbow animado, dejando todos los otros caracteres y cada secuencia de
 * control (ANSI styling + el marcador cursor zero-width) exactamente donde estaban. El visible
 * width no cambia. Devuelve la línea intacta cuando mode es "none" o la palabra clave está
 * ausente.
 */
export function colorizeKeyword(line: string, keyword: string, phase = 0, options: RainbowOptions = {}): string {
	const mode = options.mode ?? "truecolor";
	if (mode === "none" || !keyword || line.length === 0) return line;
	const key = keyword.toLowerCase();
	const hueStep = options.hueStep ?? 18;
	const phaseStep = options.phaseStep ?? 12;
	const saturation = options.saturation ?? 1;
	const lightness = options.lightness ?? 0.6;

	// Divide la línea en tokens de control (mantenidos tal cual) y caracteres visibles, registrando
	// el texto visible concatenado así podemos matchear la palabra clave plain entre escapes.
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

	// Marca, para cada carácter visible, su offset 0-based dentro de un keyword match (o -1).
	const lower = visible.toLowerCase();
	const offsetInMatch = new Array<number>(visible.length).fill(-1);
	for (let from = lower.indexOf(key); from >= 0; from = lower.indexOf(key, from + key.length)) {
		// Solo recolorea tokens de palabra clave standalone; salta substrings pegados a palabra más grande.
		if (!isKeywordLeftBoundary(lower, from) || !isKeywordRightBoundary(lower, from + key.length)) continue;
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

/** Elige el encoding de color más rico que la terminal actual publicita. */
export function detectColorMode(env: NodeJS.ProcessEnv = process.env): ColorMode {
	const colorterm = (env.COLORTERM ?? "").toLowerCase();
	if (colorterm.includes("truecolor") || colorterm.includes("24bit")) return "truecolor";
	const term = (env.TERM ?? "").toLowerCase();
	if (term.includes("truecolor") || term.includes("24bit")) return "truecolor";
	if (term.includes("256color") || term.includes("256")) return "ansi256";
	return "none";
}
