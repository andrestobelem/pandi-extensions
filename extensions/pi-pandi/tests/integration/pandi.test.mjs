#!/usr/bin/env node
/**
 * Durable behavioral test for extensions/pi-pandi pure data + helpers (moods.ts).
 *
 * Pins the tone/format contract of Pandi's rotating status text so future edits stay
 * coherent and never break the two templates the working indicator renders:
 *   `Pandi ${mood}`              and   `Pandi despierto y ${mood}`
 *
 * Contract:
 * - MOODS is a non-empty, duplicate-free list of short phrases.
 * - Every mood is trimmed, starts lowercase, and ends with a single ellipsis "…".
 * - Both render templates produce clean, non-empty strings for every mood.
 * - The list stays in the "bamboo forest" semantic field (a strong majority of moods
 *   reference panda/bamboo/forest vocabulary), so "same semantic field" is enforced,
 *   not just asserted in a commit message.
 * - pick() always returns a member of the array (incl. the single-element case).
 * - PANDI_QUOTE is a two-line, non-empty splash quote.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

// Vocabulary that anchors the "bamboo forest / panda" semantic field. A mood counts as
// in-field when it contains any of these tokens (accent- and case-insensitive substring).
const FIELD_VOCAB = [
	"bambu",
	"bambudal",
	"bosque",
	"rama",
	"ramas",
	"hoja",
	"hojas",
	"arbol",
	"brote",
	"brotes",
	"anillo",
	"anillos",
	"panda",
	"pandesc",
	"menu",
	"sol",
	"brisa",
];

function fold(value) {
	return value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();
}

async function scenarioMoodsUnit(url) {
	const { MOODS, PANDI_QUOTE, pick, greetingText } = await loadModule(url);

	check("MOODS is a non-empty array", Array.isArray(MOODS) && MOODS.length > 0, String(MOODS?.length));
	check("MOODS has no duplicates", new Set(MOODS).size === MOODS.length);

	for (const mood of MOODS) {
		check(`mood is a non-empty string: ${JSON.stringify(mood)}`, typeof mood === "string" && mood.length > 1);
		check(`mood is trimmed: ${JSON.stringify(mood)}`, mood === mood.trim());
		check(`mood ends with the ellipsis char "…": ${JSON.stringify(mood)}`, mood.endsWith("…"));
		check(`mood does not end with ascii "...": ${JSON.stringify(mood)}`, !mood.endsWith("..."));
		check(
			`mood starts lowercase: ${JSON.stringify(mood)}`,
			mood[0] === mood[0].toLowerCase() && mood[0] !== mood[0].toUpperCase(),
		);
		// Reads cleanly in BOTH templates the indicator uses. The `"${mood}"` substrings are
		// INTENTIONAL literal `${mood}` text (documenting the indicator's template), not a
		// forgotten template literal — hence the targeted biome-ignore before each template.
		check(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal `${mood}` shown in the assertion label on purpose
			`mood renders in "Pandi ${"${mood}"}": ${JSON.stringify(mood)}`,
			`Pandi ${mood}`.startsWith("Pandi ") && `Pandi ${mood}`.endsWith("…"),
		);
		check(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal `${mood}` shown in the assertion label on purpose
			`mood renders in "Pandi despierto y ${"${mood}"}": ${JSON.stringify(mood)}`,
			`Pandi despierto y ${mood}`.startsWith("Pandi despierto y ") && `Pandi despierto y ${mood}`.endsWith("…"),
		);
	}

	const inField = MOODS.filter((mood) => FIELD_VOCAB.some((word) => fold(mood).includes(word)));
	check(
		`a strong majority of moods are in the bamboo-forest field (>=60%): ${inField.length}/${MOODS.length}`,
		inField.length / MOODS.length >= 0.6,
		`${inField.length}/${MOODS.length}`,
	);

	// pick() always returns a member of the array.
	let allMembers = true;
	for (let i = 0; i < 300; i++) {
		if (!MOODS.includes(pick(MOODS))) {
			allMembers = false;
			break;
		}
	}
	check("pick(MOODS) always returns a member", allMembers);
	check("pick on a single-element array returns that element", pick(["only"]) === "only");

	check("PANDI_QUOTE has two lines", Array.isArray(PANDI_QUOTE) && PANDI_QUOTE.length === 2);
	check(
		"PANDI_QUOTE lines are non-empty strings",
		PANDI_QUOTE.every((line) => typeof line === "string" && line.trim().length > 0),
	);

	// The start greeting must NOT repeat the splash's main phrase when the splash is visible
	// (the two-line PANDI_QUOTE is the splash's job). When the splash is hidden the greeting
	// carries the quote so the meme still appears somewhere.
	check("greetingText is a function", typeof greetingText === "function");
	const withSplash = greetingText(true);
	const withoutSplash = greetingText(false);
	check("greetingText(splashVisible=true) says 'Pandi listo.'", withSplash.includes("Pandi listo."));
	check(
		`greetingText(splashVisible=true) does NOT repeat the main phrase: ${JSON.stringify(withSplash)}`,
		!withSplash.includes(PANDI_QUOTE[0]) && !withSplash.includes(PANDI_QUOTE[1]),
	);
	check(
		"greetingText(splashVisible=false) DOES carry the main phrase",
		withoutSplash.includes(PANDI_QUOTE[0]) && withoutSplash.includes(PANDI_QUOTE[1]),
	);
	check(
		"greetingText returns a trimmed, non-empty string in both modes",
		withSplash.trim() === withSplash &&
			withSplash.length > 0 &&
			withoutSplash.trim() === withoutSplash &&
			withoutSplash.length > 0,
	);
}

async function scenarioKaomojiUnit(url) {
	const { KAOMOJI_PANDAS, KAOMOJI_SEQUENCE } = await loadModule(url);

	const faces = Object.values(KAOMOJI_PANDAS ?? {});
	check("KAOMOJI_PANDAS is a non-empty face dictionary", faces.length > 0, String(faces.length));
	for (const face of faces) {
		check(
			`kaomoji face is a panda (non-empty string with the "ᴥ" snout): ${JSON.stringify(face)}`,
			typeof face === "string" && face.length > 1 && face.includes("ᴥ"),
		);
	}

	check("KAOMOJI_SEQUENCE is a non-empty array", Array.isArray(KAOMOJI_SEQUENCE) && KAOMOJI_SEQUENCE.length > 0);
	for (const frame of KAOMOJI_SEQUENCE ?? []) {
		check(
			`frame.face is a panda face: ${JSON.stringify(frame?.face)}`,
			typeof frame?.face === "string" && frame.face.includes("ᴥ"),
		);
		check(
			`frame.dots is an integer in [0, 3]: ${JSON.stringify(frame?.dots)}`,
			Number.isInteger(frame?.dots) && frame.dots >= 0 && frame.dots <= 3,
		);
	}

	// The whole point: the MOVING indicator must actually change expression, not render one
	// face forever. Pin that at least 3 distinct designed faces rotate through the animation.
	const distinctFaces = new Set((KAOMOJI_SEQUENCE ?? []).map((frame) => frame.face));
	check(
		`the animated sequence cycles >=3 distinct faces (it changes): ${distinctFaces.size}`,
		distinctFaces.size >= 3,
		String(distinctFaces.size),
	);

	// Robust terminal rendering of the faces. A face with combining marks (\p{M}) composes an
	// accent onto a base glyph — fragile across terminals when the base is not a letter (it can
	// tofu or shift a cell). Forbid them so every face is a run of standalone, width-1 glyphs.
	for (const face of faces) {
		const combining = [...face].filter((ch) => /\p{M}/u.test(ch));
		check(
			`kaomoji face has no fragile combining marks: ${JSON.stringify(face)}`,
			combining.length === 0,
			`${combining.length} combining`,
		);
	}

	// Anti-jitter invariant: every frame the MOVING indicator renders must occupy the SAME
	// number of display columns, or the carita visibly jumps as it animates. With no combining
	// marks (checked above) and no wide/ambiguous-forced glyphs, display width == code points.
	const widthOf = (s) => [...s].filter((ch) => !/\p{M}/u.test(ch)).length;
	const frameWidths = new Set((KAOMOJI_SEQUENCE ?? []).map((frame) => widthOf(frame.face)));
	check(
		`all animation frames share one display width (no jitter): ${[...frameWidths].join(",")}`,
		frameWidths.size === 1,
		`${frameWidths.size} distinct widths`,
	);
}

async function main() {
	const built = await buildExtension({
		name: "pi-pandi-moods",
		src: path.join(REPO_ROOT, "extensions", "pi-pandi", "moods.ts"),
		outName: "moods.mjs",
		npx: "--yes",
	});
	try {
		await scenarioMoodsUnit(built.url);
	} finally {
		await fs.rm(built.outDir, { recursive: true, force: true });
	}

	const builtKaomoji = await buildExtension({
		name: "pi-pandi-kaomoji",
		src: path.join(REPO_ROOT, "extensions", "pi-pandi", "kaomoji.ts"),
		outName: "kaomoji.mjs",
		npx: "--yes",
	});
	try {
		await scenarioKaomojiUnit(builtKaomoji.url);
	} finally {
		await fs.rm(builtKaomoji.outDir, { recursive: true, force: true });
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
