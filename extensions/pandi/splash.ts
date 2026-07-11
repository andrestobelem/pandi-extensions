import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	colorizeFace,
	FACE_WIDTH,
	modeFromTextColor,
	PANDA_FACE,
	pandaPalette,
	pandaPaletteFromInk,
	parseFgRgb,
} from "./face.js";
import { PANDI_QUOTE } from "./moods.js";

/** Líneas del splash: panda a la izquierda, nombre + frase a la derecha. */
export function splashLines(theme: Theme): string[] {
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
