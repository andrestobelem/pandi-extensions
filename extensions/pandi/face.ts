/**
 * Block-art puro de la cara de Pandi + paleta adaptada al tema para el splash. Sin SDK, sin
 * I/O, sin aleatoriedad al cargar el módulo: importar este archivo no tiene efectos
 * secundarios, así que puede probarse en aislamiento (index.ts es la única capa de
 * orquestación).
 *
 * Por qué usar una paleta y no blanco/negro fijos: la cara tiene dos tonos — ░ (cara clara)
 * y █ (parches oscuros: orejas, ojos, nariz). Una sola paleta fija de blanco/negro falla en
 * uno de los modos: los parches oscuros desaparecen en una terminal oscura y la cara clara
 * desaparece en una terminal clara. Por eso la paleta se ADAPTA al modo de la terminal:
 * cada tono se corre del fondo con el que, si no, se mezclaría, mientras mantiene un buen
 * contraste interno entre cara y parches para que Pandi siempre se lea como panda.
 */

export type TerminalMode = "dark" | "light";

/** Una tripla RGB de 8 bits. */
export type Rgb = readonly [number, number, number];

/** La cara del panda en block-art. ░ = cara clara, █ = parche oscuro. Los espacios son transparentes. */
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

/** Ancho de la fila más larga de la cara (para rellenar el splash en una columna prolija). */
export const FACE_WIDTH = Math.max(...PANDA_FACE.map((line) => [...line].length));

/** Los dos tonos usados para pintar la cara en un modo de terminal dado. */
export interface PandaPalette {
	/** Color para ░ — la cara clara del panda. */
	face: Rgb;
	/** Color para █ — los parches oscuros del panda (orejas, ojos, nariz). */
	patch: Rgb;
}

/**
 * Elige los tonos de cara/parches para un modo de terminal.
 * - modo dark: la cara queda en blanco brillante; el parche se levanta del negro puro para
 *   que sobreviva sobre un fondo oscuro.
 * - modo light: el parche queda casi negro para que se vea; la cara se baja del blanco puro
 *   para que siga siendo distinta de un fondo claro.
 */
export function pandaPalette(mode: TerminalMode): PandaPalette {
	return mode === "light"
		? { face: [165, 167, 173], patch: [28, 30, 34] }
		: { face: [237, 237, 232], patch: [70, 74, 82] };
}

/** Mezcla una tripla RGB hacia negro o blanco (`target`); cada canal se redondea y se acota. */
function blend([r, g, b]: Rgb, target: number, t: number): Rgb {
	const mix = (c: number) => Math.max(0, Math.min(255, Math.round(c + (target - c) * t)));
	return [mix(r), mix(g), mix(b)];
}

function cloneRgb([r, g, b]: Rgb): Rgb {
	return [r, g, b];
}

/**
 * Deriva los dos tonos de Pandi desde la tinta del THEME (el color `text`). Los themes no
 * exponen un rol explícito de blanco/negro, así que usamos el ÚNICO extremo que el theme
 * nos da — su tinta — para el tono que coincide con el modo, y derivamos el tono opuesto
 * mezclando esa misma tinta (preservando su matiz, para que un theme teñido produzca un
 * panda teñido pero monocromo):
 * - theme dark (tinta clara): face = la tinta misma (el blanco del theme); patch = tinta
 *   mezclada 70% hacia negro (una versión oscura, del mismo matiz, que sobrevive sobre un
 *   fondo oscuro).
 * - theme light (tinta oscura): patch = la tinta misma (el negro del theme); face = tinta
 *   mezclada 60% hacia blanco (una versión clara, del mismo matiz, distinta de un fondo
 *   claro).
 * El umbral del modo (luminancia del texto ≥ 0.5 ⇒ dark) garantiza ≥ 0.3 de contraste
 * entre cara y parches en ambos casos.
 */
export function pandaPaletteFromInk(ink: Rgb, mode: TerminalMode): PandaPalette {
	return mode === "light"
		? { face: blend(ink, 255, 0.6), patch: cloneRgb(ink) }
		: { face: cloneRgb(ink), patch: blend(ink, 0, 0.7) };
}

const RESET = "\x1b[0m";

/** Construye un escape SGR truecolor de foreground para una tripla RGB. */
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
 * Rol de color de la PALETA DEL TEMA para los ojos de cada carita (adaptado al tema), elegido
 * semánticamente: happy=success (verde), error=error (rojo), el resto=accent. Son nombres de
 * `ThemeColor` válidos; el orquestador los resuelve con theme.getFgAnsi(rol). Se mantiene
 * libre de SDK (as const) para que este módulo siga siendo puro y testeable en aislamiento.
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

/** Valida un estilo persistido (viene de JSON en disco); por defecto "claude" si no matchea. */
export function parseFaceStyle(raw: unknown): FaceStyle {
	return FACE_STYLES.includes(raw as FaceStyle) ? (raw as FaceStyle) : "claude";
}

/** El siguiente estilo en el ciclo, con vuelta al principio. */
export function nextFaceStyle(current: FaceStyle): FaceStyle {
	const i = FACE_STYLES.indexOf(current);
	return FACE_STYLES[(i + 1) % FACE_STYLES.length];
}

/**
 * Pinta una fila de la cara: █→bloque patch, ░→bloque face (ambos como █ sólido para que la
 * cara sea opaca), con espacios transparentes. Cada celda de tinta se resetea para que los
 * colores no se derramen.
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

/** Parsea un escape SGR truecolor de fg (`38;2;r;g;b`) a RGB; undefined para cualquier otra cosa. */
export function parseFgRgb(ansi: string): Rgb | undefined {
	const m = /38;2;(\d+);(\d+);(\d+)/.exec(ansi);
	if (!m) return undefined;
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Luminancia relativa en [0, 1] (pesos de Rec. 709), usada para comparar tonos. */
export function luminance([r, g, b]: Rgb): number {
	return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Infiere el modo de terminal desde el color principal del texto del theme: un theme light
 * usa texto oscuro y un theme dark usa texto claro, así que texto brillante => modo dark.
 * Usa el fallback cuando el color del texto no es un escape truecolor parseable (p. ej. un
 * theme de 256 colores).
 */
export function modeFromTextColor(textAnsi: string, fallback: TerminalMode = "dark"): TerminalMode {
	const rgb = parseFgRgb(textAnsi);
	if (!rgb) return fallback;
	return luminance(rgb) >= 0.5 ? "dark" : "light";
}
