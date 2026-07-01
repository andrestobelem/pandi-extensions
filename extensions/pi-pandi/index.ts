/**
 * Pandi 🐼💎 — un personaje panda para pi
 *
 * Cara de panda en block-art, con una paleta que se ADAPTA al tema (claro/oscuro) para
 * que las dos tintas — la cara clara y los parches oscuros — sigan visibles en cualquier
 * fondo de terminal. Se muestra en la PANTALLA DE PRESENTACIÓN (header de arranque) con
 * el texto al lado — como el splash de Claude Code, pero panda. Además: indicador
 * animado mientras pi piensa.
 *
 * Qué hace:
 *   - Splash en el header de arranque: panda + nombre + frase (toggle /pandi art).
 *   - Indicador animado mientras pi streamea. Dos estilos:
 *       kaomoji  ʕ•ᴥ•ʔ   ↔   Claude  (●  ●)  con ojos ◆
 *   - Verbo juguetón rotativo por turno + easter egg con la frase del meme.
 *   - Estado "◆ Pandi" en el footer.
 *
 * Ubicación: extensions/pi-pandi/index.ts (cableado en package.json + .pi/settings.json).
 *
 * Comandos:
 *   /pandi        Estado + saludo
 *   /pandi art    Mostrar/ocultar el splash del panda (header de arranque)
 *   /pandi face   Cambiar carita del indicador: kaomoji ʕ•ᴥ•ʔ ↔ Claude (●  ●) (se guarda)
 *   /pandi off    Apagar Pandi (restaura el header y el spinner default)
 *   /pandi on     Volver a encender Pandi
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ThemeColor,
	WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import {
	CLAUDE_ORANGE,
	colorizeFace,
	FACE_EYE_ROLE,
	FACE_WIDTH,
	type FaceStyle,
	fgAnsi,
	glintEye,
	modeFromTextColor,
	nextFaceStyle,
	PANDA_FACE,
	pandaPalette,
	pandaPaletteFromInk,
	parseFaceStyle,
	parseFgRgb,
} from "./face.js";
import { GREETINGS, greetingText, MOODS, PANDI_QUOTE, pick } from "./moods.js";
import { pandiPersonaBlock } from "./persona.js";

const STATUS_KEY = "pandi";

// Naranja-coral de Anthropic/Claude (el ◆ "ADN de Claude"). Mismo RGB que face.CLAUDE_ORANGE.
const ORANGE = fgAnsi(CLAUDE_ORANGE);
const RESET_FG = "\x1b[39m";
const orange = (s: string) => `${ORANGE}${s}${RESET_FG}`;

// El splash: panda a la izquierda, nombre + frase a la derecha (centrado vertical). Las dos
// tintas del panda — la cara clara y los parches oscuros — se DERIVAN de la tinta del tema
// (el color `text`): usa el blanco/negro propio del tema y deriva el tono opuesto del mismo
// matiz, para que Pandi tome los colores del tema sin dejar de ser un panda monocromo. Si el
// tema no es truecolor (256-color, sin RGB parseable) cae a la paleta fija por modo.
function splashLines(theme: Theme): string[] {
	const textAnsi = theme.getFgAnsi("text");
	const mode = modeFromTextColor(textAnsi);
	const ink = parseFgRgb(textAnsi);
	const palette = ink ? pandaPaletteFromInk(ink, mode) : pandaPalette(mode);
	const title = [theme.fg("accent", "Pandi 🐼"), theme.fg("dim", PANDI_QUOTE[0]), theme.fg("dim", PANDI_QUOTE[1])];
	const top = Math.floor((PANDA_FACE.length - title.length) / 2);
	const body = PANDA_FACE.map((line, i) => {
		const left = colorizeFace(line.padEnd(FACE_WIDTH, " "), palette);
		const t = i >= top && i < top + title.length ? `   ${title[i - top]}` : "";
		return left + t;
	});
	return ["", ...body, ""];
}

// Estilo de carita del indicador (persistido entre /reload).
function styleFile(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "pandi-style.local.json");
}
function loadStyle(): FaceStyle {
	try {
		return parseFaceStyle((JSON.parse(readFileSync(styleFile(), "utf8")) as { face?: unknown }).face);
	} catch {
		return "claude";
	}
}
function saveStyle(face: FaceStyle): void {
	try {
		writeFileSync(styleFile(), JSON.stringify({ face }));
	} catch {
		/* best-effort */
	}
}

// Las caritas kaomoji con ojos coloreados desde la PALETA DEL TEMA (theme-adaptive) según
// FACE_EYE_ROLE (happy=success, error=error, el resto=accent). Se construyen por-llamada
// porque necesitan el theme; todos los call-sites (notify) tienen ctx.ui.theme.
function pandaFaces(theme: Theme) {
	const kao = (role: keyof typeof FACE_EYE_ROLE, left: string, right: string): string => {
		const fg = theme.getFgAnsi(FACE_EYE_ROLE[role]);
		return `ʕ ${glintEye(left, fg)}ᴥ${glintEye(right, fg)} ʔ`;
	};
	const gatunoFg = theme.getFgAnsi(FACE_EYE_ROLE.gatuno);
	return {
		basico: kao("basico", "•", "•"), // panda básico
		thinking: kao("thinking", "•̀", "•́"), // decidido
		happy: kao("happy", "◕", "◕"), // ojitos grandes
		error: kao("error", "╥", "╥"), // llorando
		gatuno: `(=${glintEye("◕", gatunoFg)}ᴥ${glintEye("◕", gatunoFg)}=)`, // gatuno-panda
	};
}

/** Estilo "claude": carita `(● ●)` con ojos que a veces brillan con el rombo ◆. */
function framesClaude(theme: Theme): WorkingIndicatorOptions {
	const eye = (c: string) => (c === "◆" ? theme.fg("accent", "◆") : c);
	const face = (l: string, r: string) => `${theme.fg("dim", "(")}${eye(l)}  ${eye(r)}${theme.fg("dim", ")")}`;
	const dots = (n: number) => (n > 0 ? theme.fg("dim", ` ${".".repeat(n)}`) : "");
	return {
		frames: [
			face("●", "●") + dots(0),
			face("●", "●") + dots(1),
			face("●", "●") + dots(2),
			face("◆", "●") + dots(2), // brilla el ojo izquierdo
			face("●", "◆") + dots(3), // brilla el derecho
			face("◆", "◆") + dots(3), // alma de Claude
			face("-", "-") + dots(2), // parpadeo
			face("●", "●") + dots(1),
		],
		intervalMs: 180,
	};
}

/**
 * Estilo kaomoji genérico: el oso `ʕ ojo ᴥ ojo ʔ` (o el gatuno `(= … =)`) que parpadea, con
 * los ojos coloreados desde la PALETA DEL TEMA. Los estilos concretos difieren solo en los
 * corchetes, los ojos (pueden ser asimétricos, p. ej. el "decidido") y el rol de color.
 */
function framesKaomoji(
	theme: Theme,
	spec: { l: string; r: string; eyeL: string; eyeR: string; role: ThemeColor },
): WorkingIndicatorOptions {
	const fg = theme.getFgAnsi(spec.role);
	const face = (a: string, b: string) =>
		`${theme.fg("accent", spec.l)}${glintEye(a, fg)}${theme.fg("accent", "ᴥ")}${glintEye(b, fg)}${theme.fg("accent", spec.r)}`;
	const dots = (n: number) => (n > 0 ? theme.fg("dim", ` ${".".repeat(n)}`) : "");
	const { eyeL, eyeR } = spec;
	return {
		frames: [
			face(eyeL, eyeR) + dots(0),
			face(eyeL, eyeR) + dots(1),
			face(eyeL, eyeR) + dots(2),
			face(eyeL, eyeR) + dots(3),
			face("-", "-") + dots(3), // parpadeo
			face("·", "·") + dots(2),
			face(eyeL, eyeR) + dots(1),
			face("^", "^") + dots(0), // ojito feliz
		],
		intervalMs: 180,
	};
}

// Cada estilo del indicador → sus frames. claude tiene su propia animación (◆); los otros
// cuatro son variantes kaomoji (corchetes/ojos/color).
function pandaFrames(theme: Theme, style: FaceStyle): WorkingIndicatorOptions {
	switch (style) {
		case "kaomoji":
			return framesKaomoji(theme, { l: "ʕ ", r: " ʔ", eyeL: "•", eyeR: "•", role: "accent" });
		case "ojitos":
			return framesKaomoji(theme, { l: "ʕ ", r: " ʔ", eyeL: "◕", eyeR: "◕", role: "success" });
		case "decidido":
			return framesKaomoji(theme, { l: "ʕ ", r: " ʔ", eyeL: "•̀", eyeR: "•́", role: "accent" });
		case "gatuno":
			return framesKaomoji(theme, { l: "(=", r: "=)", eyeL: "◕", eyeR: "◕", role: "accent" });
		default:
			return framesClaude(theme);
	}
}

/** Opciones del selector de `/pandi menu` (el primer token mapea al subcomando existente). */
export const PANDI_SELECT_ITEMS = [
	"on — despertar a Pandi",
	"off — mandar a Pandi a dormir",
	"art — mostrar/ocultar el splash del panda",
	"face — cambiar la carita del indicador",
];

/**
 * Resuelve el argumento de `/pandi`. Solo `/pandi menu` (explícito) abre el selector
 * interactivo cuando hay UI; el `/pandi` pelado conserva su saludo/estado y cualquier
 * otro subcomando pasa sin tocarse. Nada regresa fuera de la TUI.
 */
export async function resolvePandiInput(input: string, ctx: ExtensionContext): Promise<string> {
	const trimmed = input.trim();
	if (trimmed.toLowerCase() !== "menu" || !ctx.hasUI || typeof ctx.ui?.select !== "function") return trimmed;
	const choice = await ctx.ui.select("Pandi 🐼", PANDI_SELECT_ITEMS);
	return choice?.split(/\s+/)[0] ?? "";
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let artVisible = true;
	let faceStyle: FaceStyle = loadStyle();

	const setSplash = (ctx: ExtensionContext) => {
		ctx.ui.setHeader(
			artVisible && enabled
				? (_tui, theme) => ({
						render: () => splashLines(theme),
						invalidate: () => {},
					})
				: undefined,
		);
	};

	const apply = (ctx: ExtensionContext) => {
		if (!enabled) return;
		ctx.ui.setWorkingIndicator(pandaFrames(ctx.ui.theme, faceStyle));
		ctx.ui.setStatus(STATUS_KEY, `${orange("◆")} ${ctx.ui.theme.fg("accent", "Pandi")}`);
		setSplash(ctx);
	};

	const restoreDefaults = (ctx: ExtensionContext) => {
		ctx.ui.setWorkingIndicator(); // spinner default de pi
		ctx.ui.setWorkingMessage(); // mensaje default de pi
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setHeader(undefined); // header built-in de pi
	};

	pi.on("session_start", async (_event, ctx) => {
		apply(ctx);
		if (enabled) {
			const f = pandaFaces(ctx.ui.theme);
			const greet = Math.random() < 0.1 ? f.gatuno : f.happy; // easter egg gatuno-panda
			// No repitas la frase principal si el splash ya la muestra (artVisible): en su lugar
			// un saludo tierno/zen rotativo. Solo llevamos la frase en el saludo si el splash está
			// oculto.
			ctx.ui.notify(`${greet} ${greetingText(artVisible, pick(GREETINGS))}`, "info");
		}
	});

	// System append: mientras Pandi está encendido, sumá su persona (tierno/zen + firma 🐼)
	// al final del system prompt. /pandi off la quita (no devolvemos nada). Nunca pisamos el
	// prompt original: appendeamos a event.systemPrompt.
	pi.on("before_agent_start", async (event) => {
		if (!enabled) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${pandiPersonaBlock()}` };
	});

	pi.on("turn_start", async (_event, ctx) => {
		if (!enabled) return;
		// 1 de cada 4 turnos, easter egg con la frase del meme; si no, un verbo.
		const msg = Math.random() < 0.25 ? PANDI_QUOTE[0] : `Pandi ${pick(MOODS)}`;
		ctx.ui.setWorkingMessage(msg);
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!enabled) return;
		ctx.ui.setWorkingMessage(); // limpia el verbo hasta el próximo turno
	});

	pi.registerCommand("pandi", {
		description: "Pandi 🐼 — estado / menu / art / face / on / off",
		handler: async (args, ctx) => {
			const cmd = (await resolvePandiInput(args, ctx)).trim().toLowerCase();
			const f = pandaFaces(ctx.ui.theme);

			if (cmd === "off") {
				enabled = false;
				restoreDefaults(ctx);
				ctx.ui.notify(`${f.thinking} Pandi se fue a dormir (header y spinner default restaurados).`, "info");
				return;
			}

			if (cmd === "on") {
				enabled = true;
				apply(ctx);
				ctx.ui.notify(`${f.happy} ¡Pandi volvió!`, "info");
				return;
			}

			if (cmd === "art") {
				if (!enabled) {
					ctx.ui.notify(`${f.thinking} Pandi está dormido. Usá /pandi on primero.`, "info");
					return;
				}
				artVisible = !artVisible;
				setSplash(ctx);
				ctx.ui.notify(artVisible ? `${f.happy} Splash del panda activado.` : "Splash oculto.", "info");
				return;
			}

			if (cmd === "face") {
				if (!enabled) {
					ctx.ui.notify(`${f.thinking} Pandi está dormido. Usá /pandi on primero.`, "info");
					return;
				}
				faceStyle = nextFaceStyle(faceStyle);
				saveStyle(faceStyle);
				const frames = pandaFrames(ctx.ui.theme, faceStyle);
				ctx.ui.setWorkingIndicator(frames);
				// Muestro el primer frame como sample en vivo del estilo recién elegido.
				ctx.ui.notify(`${frames.frames?.[0] ?? ""} Estilo ${faceStyle} (guardado).`, "info");
				return;
			}

			// /pandi (sin args): estado + saludo
			apply(ctx);
			ctx.ui.notify(
				enabled
					? `${f.happy} Pandi despierto y ${pick(MOODS)}`
					: `${f.thinking} Pandi dormido. Usá /pandi on para despertarlo.`,
				"info",
			);
		},
	});
}
