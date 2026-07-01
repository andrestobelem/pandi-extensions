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
	const { MOODS, GREETINGS, PANDI_QUOTE, pick, greetingText } = await loadModule(url);

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

	// GREETINGS: tierno/zen "otra cosa" shown after "Pandi listo." when the splash is visible,
	// so we never repeat the splash's main phrase. Complete sentences, not the MOOD gerunds.
	check("GREETINGS is a non-empty array", Array.isArray(GREETINGS) && GREETINGS.length > 0, String(GREETINGS?.length));
	check("GREETINGS has no duplicates", new Set(GREETINGS).size === GREETINGS.length);
	for (const g of GREETINGS) {
		check(`greeting is a non-empty string: ${JSON.stringify(g)}`, typeof g === "string" && g.length > 1);
		check(`greeting is trimmed: ${JSON.stringify(g)}`, g === g.trim());
		check(
			`greeting starts uppercase (a sentence): ${JSON.stringify(g)}`,
			g[0] === g[0].toUpperCase() && g[0] !== g[0].toLowerCase(),
		);
		check(`greeting ends with sentence punctuation: ${JSON.stringify(g)}`, /[.…]$/.test(g));
		check(
			`greeting never repeats the splash phrase: ${JSON.stringify(g)}`,
			!g.includes(PANDI_QUOTE[0]) && !g.includes(PANDI_QUOTE[1]),
		);
	}
	const greetInField = GREETINGS.filter((g) => FIELD_VOCAB.some((word) => fold(g).includes(word)));
	check(
		`a strong majority of greetings are in the bamboo-forest field (>=60%): ${greetInField.length}/${GREETINGS.length}`,
		greetInField.length / GREETINGS.length >= 0.6,
		`${greetInField.length}/${GREETINGS.length}`,
	);

	// The start greeting must NOT repeat the splash's main phrase when the splash is visible
	// (the two-line PANDI_QUOTE is the splash's job): instead it says "Pandi listo." + a
	// tierno/zen flavor line. When the splash is hidden the greeting carries the quote so the
	// meme still appears somewhere. Randomness lives at the call-site (pick), so greetingText
	// takes the chosen flavor and stays deterministic/testable.
	check("greetingText is a function", typeof greetingText === "function");
	const flavor = GREETINGS[0];
	const withSplash = greetingText(true, flavor);
	const withoutSplash = greetingText(false, flavor);
	check("greetingText(splashVisible=true) says 'Pandi listo.'", withSplash.includes("Pandi listo."));
	check(
		`greetingText(splashVisible=true) includes the flavor line: ${JSON.stringify(withSplash)}`,
		withSplash.includes(flavor),
	);
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
