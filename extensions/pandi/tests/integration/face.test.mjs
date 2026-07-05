#!/usr/bin/env node
/**
 * Test de comportamiento durable para el arte puro de la cara y la paleta adaptada al tema
 * de extensions/pandi (face.ts).
 *
 * El splash de Pandi es block-art pintado con dos tonos: ░ (la cara clara) y █ (los
 * parches oscuros: orejas, ojos, nariz). Con una sola paleta fija de blanco/negro, el
 * splash se rompe en uno de los dos modos: los parches oscuros desaparecen en una terminal
 * oscura y la cara clara desaparece en una terminal clara. Esta suite fija el contrato de
 * que la paleta se ADAPTA al modo de la terminal para que AMBOS tonos sigan visibles en
 * AMBOS modos.
 *
 * Contrato:
 * - PANDA_FACE es un array no vacío de strings hechos solo de █ / ░ / espacio, y usa AMBOS
 *   caracteres de tinta; FACE_WIDTH es la fila más ancha.
 * - pandaPalette(mode) devuelve dos tonos distintos; los modos light y dark difieren.
 * - En todos los modos, el tono de la cara es más claro que el del parche (es un panda).
 * - Modo dark: el parche oscuro se levanta del negro puro para que siga visible sobre un
 *   fondo oscuro; la cara es el tono más brillante de todos.
 * - Modo light: el parche oscuro queda casi negro (visible sobre un fondo claro) y el tono
 *   de la cara se baja del blanco puro para que sea distinto de un fondo claro.
 * - colorizeFace mapea █→bloque patch, ░→bloque face, deja los espacios transparentes y
 *   resetea.
 * - parseFgRgb lee un escape SGR truecolor y rechaza non-truecolor / basura.
 * - luminance es monótona y está acotada en [0, 1].
 * - modeFromTextColor infiere "dark" desde texto claro, "light" desde texto oscuro, y
 *   usa fallback cuando el color del texto no es truecolor.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function scenarioFaceUnit(url) {
	const {
		PANDA_FACE,
		FACE_WIDTH,
		pandaPalette,
		pandaPaletteFromInk,
		colorizeFace,
		fgAnsi,
		parseFgRgb,
		luminance,
		modeFromTextColor,
		glintEye,
		FACE_EYE_ROLE,
		FACE_STYLES,
		parseFaceStyle,
		nextFaceStyle,
	} = await loadModule(url);

	// --- Forma del arte -------------------------------------------------------------
	check("PANDA_FACE is a non-empty array", Array.isArray(PANDA_FACE) && PANDA_FACE.length > 0);
	check(
		"PANDA_FACE rows only use █ / ░ / space",
		PANDA_FACE.every((row) => typeof row === "string" && /^[█░ ]+$/u.test(row)),
	);
	const allInk = PANDA_FACE.join("");
	check("PANDA_FACE uses the light face ink ░", allInk.includes("░"));
	check("PANDA_FACE uses the dark patch ink █", allInk.includes("█"));
	check(
		"FACE_WIDTH is the widest row",
		FACE_WIDTH === Math.max(...PANDA_FACE.map((r) => [...r].length)),
		String(FACE_WIDTH),
	);

	// --- La paleta se adapta al modo -----------------------------------------------
	const dark = pandaPalette("dark");
	const light = pandaPalette("light");
	for (const [name, pal] of [
		["dark", dark],
		["light", light],
	]) {
		check(`pandaPalette("${name}") has face + patch RGB triples`, isRgb(pal.face) && isRgb(pal.patch));
		check(
			`pandaPalette("${name}") face is lighter than patch (it is a panda)`,
			luminance(pal.face) > luminance(pal.patch),
		);
	}
	check(
		"light vs dark palettes are not identical (Pandi changes color with the theme)",
		JSON.stringify(dark) !== JSON.stringify(light),
	);

	// Modo dark: el parche se levanta del negro puro para que sobreviva sobre un fondo
	// oscuro; la cara es el tono más brillante que usamos.
	check("dark-mode patch stays visible on dark bg (lum >= 0.2)", luminance(dark.patch) >= 0.2, lum(dark.patch));
	check(
		"dark-mode face is the brightest tone (lum >= light-mode face)",
		luminance(dark.face) >= luminance(light.face),
	);
	check("dark-mode face is bright (lum >= 0.8)", luminance(dark.face) >= 0.8, lum(dark.face));

	// Modo light: el parche queda casi negro para que se vea sobre un fondo claro; la cara
	// se baja del blanco para que sea distinta de un fondo claro.
	check("light-mode patch is dark, visible on light bg (lum <= 0.2)", luminance(light.patch) <= 0.2, lum(light.patch));
	check("light-mode face is pulled off pure white (lum <= 0.75)", luminance(light.face) <= 0.75, lum(light.face));

	// Ambos modos mantienen un fuerte contraste interno entre cara y parches.
	for (const [name, pal] of [
		["dark", dark],
		["light", light],
	]) {
		check(
			`${name}-mode keeps strong face/patch contrast (>= 0.3)`,
			luminance(pal.face) - luminance(pal.patch) >= 0.3,
			(luminance(pal.face) - luminance(pal.patch)).toFixed(3),
		);
	}

	// --- pandaPaletteFromInk (blanco y negro derivados del theme) -------------------
	// En vez de crema/gris fijos, derivamos los dos tonos de Pandi desde la tinta del THEME
	// (el color `text`). El theme no tiene un rol explícito de blanco/negro, así que el tono
	// claro reutiliza la propia tinta clara del theme y el tono oscuro es esa misma tinta
	// escalada hacia abajo (mismo matiz), y viceversa en modo light. Así Pandi toma el
	// blanco/negro exacto del theme sin dejar de ser un panda reconocible y consistente en
	// matiz.
	check("pandaPaletteFromInk is exported", typeof pandaPaletteFromInk === "function");
	if (typeof pandaPaletteFromInk === "function") {
		const whiteInk = [237, 237, 232]; // el `text` casi blanco de un theme dark
		const blackInk = [28, 30, 34]; // el `text` casi negro de un theme light
		const tintInk = [230, 215, 245]; // un blanco de theme dark con tinte violáceo
		const d = pandaPaletteFromInk(whiteInk, "dark");
		const l = pandaPaletteFromInk(blackInk, "light");
		const t = pandaPaletteFromInk(tintInk, "dark");

		check("pandaPaletteFromInk returns face + patch RGB triples", isRgb(d.face) && isRgb(d.patch));
		// Modo dark: el BLANCO del panda es la propia tinta clara del theme; el negro se deriva de ella.
		check("dark ink: face IS the theme's light ink (uses the theme white)", deepEq(d.face, whiteInk));
		check("dark ink: face lighter than patch (still a panda)", luminance(d.face) > luminance(d.patch));
		check("dark ink: strong face/patch contrast (>= 0.3)", luminance(d.face) - luminance(d.patch) >= 0.3);
		check("dark ink: patch stays visible on dark bg (lum >= 0.15)", luminance(d.patch) >= 0.15, lum(d.patch));
		// Modo light: el NEGRO del panda es la propia tinta oscura del theme; el blanco se deriva de ella.
		check("light ink: patch IS the theme's dark ink (uses the theme black)", deepEq(l.patch, blackInk));
		check("light ink: face lighter than patch", luminance(l.face) > luminance(l.patch));
		check("light ink: strong face/patch contrast (>= 0.3)", luminance(l.face) - luminance(l.patch) >= 0.3);
		check("light ink: patch stays dark on light bg (lum <= 0.25)", luminance(l.patch) <= 0.25, lum(l.patch));
		// Preservación del tinte: una tinta violácea produce un tono derivado violáceo (no gris).
		check("tinted ink: derived patch keeps the ink's dominant channel", argmax(t.patch) === argmax(tintInk));
	}

	// --- colorizeFace ---------------------------------------------------------------
	const faceAnsi = fgAnsi(dark.face);
	const patchAnsi = fgAnsi(dark.patch);
	const painted = colorizeFace("█░ ░█", dark);
	check("colorizeFace paints █ with the patch tone", painted.includes(`${patchAnsi}█`));
	check("colorizeFace paints ░ as a solid block with the face tone", painted.includes(`${faceAnsi}█`));
	check("colorizeFace keeps spaces transparent", painted.includes(" "));
	check("colorizeFace resets color after ink", painted.includes("\x1b[0m"));
	check("colorizeFace leaves no raw ░ / █ source ink in the output", !painted.includes("░"));

	// --- parseFgRgb / luminance -----------------------------------------------------
	check("parseFgRgb reads a truecolor fg escape", deepEq(parseFgRgb("\x1b[38;2;10;20;30m"), [10, 20, 30]));
	check("parseFgRgb rejects a 256-color escape", parseFgRgb("\x1b[38;5;200m") === undefined);
	check("parseFgRgb rejects garbage", parseFgRgb("not-an-escape") === undefined);

	// --- glintEye (ojos coloreados por el theme) ------------------------------------
	// glintEye pinta un glifo de ojo en un escape de fg DADO (el orquestador pasa un color de
	// la paleta del theme vía theme.getFgAnsi(role); acá no vive ningún color hardcodeado).
	// Los riesgos reales: el color debe RESETearse después del ojo (o se derrama al resto de
	// la línea) y los ojos con acento combinante (la cara "decidido" "•̀") deben
	// sobrevivir intactos.
	const someFg = fgAnsi([12, 34, 56]);
	const glint = glintEye("•", someFg);
	check("glintEye wraps the eye in the GIVEN fg escape", glint.startsWith(someFg));
	check("glintEye resets color after the eye", glint.endsWith("\x1b[0m"));
	check("glintEye preserves a combining-accent eye glyph (decidido)", glintEye("•̀", someFg).includes("•̀"));

	// --- FACE_EYE_ROLE (paleta semántica del theme por carita) ----------------------
	// Los ojos de las caritas se colorean desde la paleta del THEME, semánticamente:
	// happy=success (verde), error=error (rojo), el resto=accent. Esto fija esa intención
	// contra regresiones.
	check("FACE_EYE_ROLE.happy uses the theme success role", FACE_EYE_ROLE.happy === "success");
	check("FACE_EYE_ROLE.error uses the theme error role", FACE_EYE_ROLE.error === "error");
	check("FACE_EYE_ROLE.thinking uses the theme accent role", FACE_EYE_ROLE.thinking === "accent");
	check(
		"FACE_EYE_ROLE values are all non-empty strings",
		Object.values(FACE_EYE_ROLE).every((v) => typeof v === "string" && v.length > 0),
	);

	// --- FACE_STYLES + ciclado (/pandi face) ----------------------------------------
	// /pandi face recorre una lista ORDENADA de 5 estilos de indicador; el estilo
	// persistido se valida al cargar (la basura cae a claude) y el ciclo vuelve al inicio.
	check(
		"FACE_STYLES has 5 indicator styles",
		Array.isArray(FACE_STYLES) && FACE_STYLES.length === 5,
		String(FACE_STYLES?.length),
	);
	check("FACE_STYLES are unique", new Set(FACE_STYLES).size === FACE_STYLES.length);
	check("FACE_STYLES includes claude + kaomoji", FACE_STYLES.includes("claude") && FACE_STYLES.includes("kaomoji"));
	check("parseFaceStyle keeps a valid style", parseFaceStyle("gatuno") === "gatuno");
	check(
		"parseFaceStyle falls back to claude on junk/undefined",
		parseFaceStyle("nope") === "claude" && parseFaceStyle(undefined) === "claude",
	);
	check("nextFaceStyle advances to the next style", nextFaceStyle(FACE_STYLES[0]) === FACE_STYLES[1]);
	check(
		"nextFaceStyle wraps around at the end",
		nextFaceStyle(FACE_STYLES[FACE_STYLES.length - 1]) === FACE_STYLES[0],
	);

	check("luminance(black) is 0", luminance([0, 0, 0]) === 0);
	check("luminance(white) is ~1", Math.abs(luminance([255, 255, 255]) - 1) < 1e-9);
	check("luminance is monotonic", luminance([200, 200, 200]) > luminance([50, 50, 50]));

	// --- modeFromTextColor ----------------------------------------------------------
	check("light (high-lum) text => dark mode", modeFromTextColor("\x1b[38;2;229;229;231m") === "dark");
	check("dark (low-lum) text => light mode", modeFromTextColor("\x1b[38;2;0;0;0m") === "light");
	check("non-truecolor text falls back to dark by default", modeFromTextColor("\x1b[38;5;15m") === "dark");
	check("non-truecolor text honors an explicit fallback", modeFromTextColor("\x1b[38;5;15m", "light") === "light");
}

function isRgb(v) {
	return Array.isArray(v) && v.length === 3 && v.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
}
function deepEq(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}
function lum(rgb) {
	return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
}
function argmax(rgb) {
	let best = 0;
	for (let i = 1; i < rgb.length; i++) if (rgb[i] > rgb[best]) best = i;
	return best;
}

async function main() {
	const built = await buildExtension({
		name: "pi-pandi-face",
		src: path.join(REPO_ROOT, "extensions", "pandi", "face.ts"),
		outName: "face.mjs",
	});
	try {
		await scenarioFaceUnit(built.url);
	} finally {
		await fs.rm(built.outDir, { recursive: true, force: true });
	}

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log("Failures:");
		for (const failure of counts.failures) console.log(`- ${failure}`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(2);
});
