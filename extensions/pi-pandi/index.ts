/**
 * Pandi 🐼💎 — un personaje panda para pi
 *
 * Cara de panda en block-art, pintada en blanco/negro real, mostrada en la
 * PANTALLA DE PRESENTACIÓN (header de arranque) con el texto al lado — como el
 * splash de Claude Code, pero panda. Además: indicador animado mientras pi piensa.
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
import type { ExtensionAPI, ExtensionContext, Theme, WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";
import { MOODS, PANDI_QUOTE, pick } from "./moods.js";

const STATUS_KEY = "pandi";

// Naranja-coral de Anthropic/Claude (el ◆ "ADN de Claude").
const ORANGE = "\x1b[38;2;217;119;87m";
const RESET_FG = "\x1b[39m";
const orange = (s: string) => `${ORANGE}${s}${RESET_FG}`;

// Blanco y negro del panda (bloques sólidos coloreados, se ven igual en cualquier terminal).
const BLACK = "\x1b[38;2;28;30;34m";
const WHITE = "\x1b[38;2;237;237;232m";
const RESET = "\x1b[0m";

// La cara de panda (block-art). ░ = blanco, █ = negro.
const PANDA_FACE = [
	"████    ████",
	"░░░░░░░░░░░░░░░░",
	"░░████░░░░████░░",
	"░░░░░░████░░░░░░",
	"░░░░░░░░░░░░░░░░",
	"██░░░░░░░░░░░░██",
	"██░░░░░░░░░░░░██",
	"  ░░░░░░░░░░░░  ",
	"  ████    ████",
];
const FACE_W = Math.max(...PANDA_FACE.map((l) => l.length));

// Pinta █→negro y ░→blanco como bloques sólidos; deja los espacios transparentes.
function colorizeFace(line: string): string {
	let out = "";
	for (const ch of line) {
		if (ch === "█") out += `${BLACK}█${RESET}`;
		else if (ch === "░") out += `${WHITE}█${RESET}`;
		else out += " ";
	}
	return out;
}

// El splash: panda a la izquierda, nombre + frase a la derecha (centrado vertical).
function splashLines(theme: Theme): string[] {
	const title = [theme.fg("accent", "Pandi 🐼"), theme.fg("dim", PANDI_QUOTE[0]), theme.fg("dim", PANDI_QUOTE[1])];
	const top = Math.floor((PANDA_FACE.length - title.length) / 2);
	const body = PANDA_FACE.map((line, i) => {
		const left = colorizeFace(line.padEnd(FACE_W, " "));
		const t = i >= top && i < top + title.length ? `   ${title[i - top]}` : "";
		return left + t;
	});
	return ["", ...body, ""];
}

// Estilo de carita del indicador (persistido entre /reload).
type FaceStyle = "claude" | "kaomoji";
function styleFile(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "pandi-style.local.json");
}
function loadStyle(): FaceStyle {
	try {
		return (JSON.parse(readFileSync(styleFile(), "utf8")) as { face?: string }).face === "kaomoji"
			? "kaomoji"
			: "claude";
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

// Los pandas kaomoji.
const PANDA = {
	basico: "ʕ •ᴥ• ʔ", // panda básico
	ojitos: "ʕ ◕ᴥ◕ ʔ", // ojitos grandes
	llorando: "ʕ ╥ᴥ╥ ʔ", // llorando
	decidido: "ʕ •̀ᴥ•́ ʔ", // decidido
	gatuno: "(=◕ᴥ◕=)", // gatuno-panda
} as const;

// Carita por estado.
const FACE = {
	thinking: PANDA.decidido,
	happy: PANDA.ojitos,
	error: PANDA.llorando,
} as const;

/** Estilo "claude": carita `(● ●)` con ojos que a veces brillan con el rombo ◆. */
function framesClaude(theme: Theme): WorkingIndicatorOptions {
	const eye = (c: string) => (c === "◆" ? orange("◆") : c);
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

/** Estilo "kaomoji": el oso `ʕ•ᴥ•ʔ` que parpadea. */
function framesKaomoji(theme: Theme): WorkingIndicatorOptions {
	const face = (eyes: string) => theme.fg("accent", `ʕ ${eyes}ᴥ${eyes} ʔ`);
	const dots = (n: number) => (n > 0 ? theme.fg("dim", ` ${".".repeat(n)}`) : "");
	return {
		frames: [
			face("•") + dots(0),
			face("•") + dots(1),
			face("•") + dots(2),
			face("•") + dots(3),
			face("-") + dots(3), // parpadeo
			face("·") + dots(2),
			face("•") + dots(1),
			face("^") + dots(0), // ojito feliz
		],
		intervalMs: 180,
	};
}

function pandaFrames(theme: Theme, style: FaceStyle): WorkingIndicatorOptions {
	return style === "kaomoji" ? framesKaomoji(theme) : framesClaude(theme);
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
			const greet = Math.random() < 0.1 ? PANDA.gatuno : FACE.happy; // easter egg gatuno-panda
			ctx.ui.notify(`${greet} Pandi listo. ${PANDI_QUOTE[0]} ${PANDI_QUOTE[1]}`, "info");
		}
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
		description: "Pandi 🐼 — estado / art / face / on / off",
		handler: async (args, ctx) => {
			const cmd = args.trim().toLowerCase();

			if (cmd === "off") {
				enabled = false;
				restoreDefaults(ctx);
				ctx.ui.notify(`${FACE.thinking} Pandi se fue a dormir (header y spinner default restaurados).`, "info");
				return;
			}

			if (cmd === "on") {
				enabled = true;
				apply(ctx);
				ctx.ui.notify(`${FACE.happy} ¡Pandi volvió!`, "info");
				return;
			}

			if (cmd === "art") {
				if (!enabled) {
					ctx.ui.notify(`${FACE.thinking} Pandi está dormido. Usá /pandi on primero.`, "info");
					return;
				}
				artVisible = !artVisible;
				setSplash(ctx);
				ctx.ui.notify(artVisible ? `${FACE.happy} Splash del panda activado.` : "Splash oculto.", "info");
				return;
			}

			if (cmd === "face") {
				if (!enabled) {
					ctx.ui.notify(`${FACE.thinking} Pandi está dormido. Usá /pandi on primero.`, "info");
					return;
				}
				faceStyle = faceStyle === "kaomoji" ? "claude" : "kaomoji";
				saveStyle(faceStyle);
				ctx.ui.setWorkingIndicator(pandaFrames(ctx.ui.theme, faceStyle));
				ctx.ui.notify(
					faceStyle === "kaomoji"
						? `${ctx.ui.theme.fg("accent", PANDA.basico)} Estilo kaomoji (guardado).`
						: `(${orange("◆")} ᴗ ${orange("◆")}) Estilo Claude (guardado).`,
					"info",
				);
				return;
			}

			// /pandi (sin args): estado + saludo
			apply(ctx);
			ctx.ui.notify(
				enabled
					? `${FACE.happy} Pandi despierto y ${pick(MOODS)}`
					: `${FACE.thinking} Pandi dormido. Usá /pandi on para despertarlo.`,
				"info",
			);
		},
	});
}
