#!/usr/bin/env node
/**
 * Durable behavioral test for extensions/pi-pandi pure face art + theme-adaptive palette
 * (face.ts).
 *
 * Pandi's splash is block-art painted with two tones: ░ (the light face) and █ (the dark
 * patches: ears, eyes, nose). With a single fixed black/white palette the splash breaks
 * in one of the two modes — the dark patches disappear on a dark terminal, and the light
 * face disappears on a light terminal. This suite pins the contract that the palette
 * ADAPTS to the terminal mode so BOTH tones stay visible in BOTH modes.
 *
 * Contract:
 * - PANDA_FACE is a non-empty array of strings made only of █ / ░ / space, and uses BOTH
 *   ink characters; FACE_WIDTH is the widest row.
 * - pandaPalette(mode) returns two distinct tones; light and dark modes differ.
 * - In every mode the face tone is lighter than the patch tone (it is a panda).
 * - Dark mode: the dark patch is lifted off pure black so it stays visible on a dark
 *   background; the face is the brightest tone overall.
 * - Light mode: the dark patch is near-black (visible on a light background) and the face
 *   tone is pulled down off pure white so it is distinct from a light background.
 * - colorizeFace maps █→patch block, ░→face block, keeps spaces transparent, and resets.
 * - parseFgRgb reads a truecolor SGR escape and rejects non-truecolor / garbage.
 * - luminance is monotonic and bounded in [0, 1].
 * - modeFromTextColor infers "dark" from light text, "light" from dark text, and falls
 *   back when the text color is not truecolor.
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

	// --- Art shape -----------------------------------------------------------------
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

	// --- Palette adapts to mode ----------------------------------------------------
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

	// Dark mode: patch lifted off pure black so it survives a dark background; face is the
	// brightest tone we ever use.
	check("dark-mode patch stays visible on dark bg (lum >= 0.2)", luminance(dark.patch) >= 0.2, lum(dark.patch));
	check(
		"dark-mode face is the brightest tone (lum >= light-mode face)",
		luminance(dark.face) >= luminance(light.face),
	);
	check("dark-mode face is bright (lum >= 0.8)", luminance(dark.face) >= 0.8, lum(dark.face));

	// Light mode: patch near-black so it shows on a light bg; face pulled down off white so
	// it is distinct from a light background.
	check("light-mode patch is dark, visible on light bg (lum <= 0.2)", luminance(light.patch) <= 0.2, lum(light.patch));
	check("light-mode face is pulled off pure white (lum <= 0.75)", luminance(light.face) <= 0.75, lum(light.face));

	// Both modes keep strong internal face/patch contrast.
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

	// --- pandaPaletteFromInk (theme-derived black & white) -------------------------
	// Instead of fixed cream/gray, derive Pandi's two tones from the THEME's ink (the `text`
	// color). The theme has no explicit black/white role, so: the light tone reuses the
	// theme's own light ink and the dark tone is that same ink scaled down (same hue), and
	// vice-versa in light mode. This makes Pandi pick up the theme's exact white/black while
	// staying a recognizable, hue-consistent panda.
	check("pandaPaletteFromInk is exported", typeof pandaPaletteFromInk === "function");
	if (typeof pandaPaletteFromInk === "function") {
		const whiteInk = [237, 237, 232]; // a dark theme's near-white `text`
		const blackInk = [28, 30, 34]; // a light theme's near-black `text`
		const tintInk = [230, 215, 245]; // a purple-tinted dark-theme white
		const d = pandaPaletteFromInk(whiteInk, "dark");
		const l = pandaPaletteFromInk(blackInk, "light");
		const t = pandaPaletteFromInk(tintInk, "dark");

		check("pandaPaletteFromInk returns face + patch RGB triples", isRgb(d.face) && isRgb(d.patch));
		// Dark mode: the panda's WHITE is the theme's own light ink; the black is derived from it.
		check("dark ink: face IS the theme's light ink (uses the theme white)", deepEq(d.face, whiteInk));
		check("dark ink: face lighter than patch (still a panda)", luminance(d.face) > luminance(d.patch));
		check("dark ink: strong face/patch contrast (>= 0.3)", luminance(d.face) - luminance(d.patch) >= 0.3);
		check("dark ink: patch stays visible on dark bg (lum >= 0.15)", luminance(d.patch) >= 0.15, lum(d.patch));
		// Light mode: the panda's BLACK is the theme's own dark ink; the white is derived from it.
		check("light ink: patch IS the theme's dark ink (uses the theme black)", deepEq(l.patch, blackInk));
		check("light ink: face lighter than patch", luminance(l.face) > luminance(l.patch));
		check("light ink: strong face/patch contrast (>= 0.3)", luminance(l.face) - luminance(l.patch) >= 0.3);
		check("light ink: patch stays dark on light bg (lum <= 0.25)", luminance(l.patch) <= 0.25, lum(l.patch));
		// Tint preservation: a purple-tinted ink yields a purple-tinted (not gray) derived tone.
		check("tinted ink: derived patch keeps the ink's dominant channel", argmax(t.patch) === argmax(tintInk));
	}

	// --- colorizeFace --------------------------------------------------------------
	const faceAnsi = fgAnsi(dark.face);
	const patchAnsi = fgAnsi(dark.patch);
	const painted = colorizeFace("█░ ░█", dark);
	check("colorizeFace paints █ with the patch tone", painted.includes(`${patchAnsi}█`));
	check("colorizeFace paints ░ as a solid block with the face tone", painted.includes(`${faceAnsi}█`));
	check("colorizeFace keeps spaces transparent", painted.includes(" "));
	check("colorizeFace resets color after ink", painted.includes("\x1b[0m"));
	check("colorizeFace leaves no raw ░ / █ source ink in the output", !painted.includes("░"));

	// --- parseFgRgb / luminance ----------------------------------------------------
	check("parseFgRgb reads a truecolor fg escape", deepEq(parseFgRgb("\x1b[38;2;10;20;30m"), [10, 20, 30]));
	check("parseFgRgb rejects a 256-color escape", parseFgRgb("\x1b[38;5;200m") === undefined);
	check("parseFgRgb rejects garbage", parseFgRgb("not-an-escape") === undefined);

	// --- glintEye (theme-colored eyes) ---------------------------------------------
	// glintEye paints an eye glyph in a GIVEN fg escape (the orchestrator passes a theme
	// palette color via theme.getFgAnsi(role) — no hardcoded color lives here). The real
	// risks: the color must RESET after the eye (or it bleeds into the rest of the line) and
	// combining-accent eyes (the "decidido" face "•̀") must survive intact.
	const someFg = fgAnsi([12, 34, 56]);
	const glint = glintEye("•", someFg);
	check("glintEye wraps the eye in the GIVEN fg escape", glint.startsWith(someFg));
	check("glintEye resets color after the eye", glint.endsWith("\x1b[0m"));
	check("glintEye preserves a combining-accent eye glyph (decidido)", glintEye("•̀", someFg).includes("•̀"));

	// --- FACE_EYE_ROLE (semantic theme palette per face) ---------------------------
	// The faces' eyes are colored from the THEME palette, semantically: happy=success (green),
	// error=error (red), the rest=accent. This pins that intent against regressions.
	check("FACE_EYE_ROLE.happy uses the theme success role", FACE_EYE_ROLE.happy === "success");
	check("FACE_EYE_ROLE.error uses the theme error role", FACE_EYE_ROLE.error === "error");
	check("FACE_EYE_ROLE.thinking uses the theme accent role", FACE_EYE_ROLE.thinking === "accent");
	check(
		"FACE_EYE_ROLE values are all non-empty strings",
		Object.values(FACE_EYE_ROLE).every((v) => typeof v === "string" && v.length > 0),
	);

	// --- FACE_STYLES + cycling (/pandi face) ---------------------------------------
	// /pandi face cycles through an ORDERED list of 5 indicator styles; the persisted style
	// is validated on load (junk falls back to claude) and cycling wraps around.
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

	// --- modeFromTextColor ---------------------------------------------------------
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
		src: path.join(REPO_ROOT, "extensions", "pi-pandi", "face.ts"),
		outName: "face.mjs",
		npx: "--yes",
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
