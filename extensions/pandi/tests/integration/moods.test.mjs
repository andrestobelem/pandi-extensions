#!/usr/bin/env node
/**
 * Caracteriza los datos y helpers puros de `moods.ts`.
 * Protege el formato que usan el indicador y el saludo: frases consistentes, campo semántico
 * de bosque de bambú y una cita que no se repite cuando el splash ya la muestra.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

// Tokens que representan el campo semántico acordado, comparados sin tildes ni mayúsculas.
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

async function main() {
	const built = await buildExtension({
		name: "pi-pandi-moods",
		src: path.join(REPO_ROOT, "extensions", "pandi", "moods.ts"),
		outName: "moods.mjs",
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

async function scenarioMoodsUnit(url) {
	const { MOODS, GREETINGS, PANDI_QUOTE, pick, greetingText } = await loadModule(url);

	checkMoods(MOODS);
	checkPicker(MOODS, pick);
	checkQuote(PANDI_QUOTE);
	checkGreetings(GREETINGS, PANDI_QUOTE);
	checkGreetingText(greetingText, GREETINGS, PANDI_QUOTE);
}

function checkMoods(moods) {
	check("MOODS is a non-empty array", Array.isArray(moods) && moods.length > 0, String(moods?.length));
	check("MOODS has no duplicates", new Set(moods).size === moods.length);

	for (const mood of moods) {
		check(`mood is a non-empty string: ${JSON.stringify(mood)}`, typeof mood === "string" && mood.length > 1);
		check(`mood is trimmed: ${JSON.stringify(mood)}`, mood === mood.trim());
		check(`mood ends with the ellipsis char "…": ${JSON.stringify(mood)}`, mood.endsWith("…"));
		check(`mood does not end with ascii "...": ${JSON.stringify(mood)}`, !mood.endsWith("..."));
		check(
			`mood starts lowercase: ${JSON.stringify(mood)}`,
			mood[0] === mood[0].toLowerCase() && mood[0] !== mood[0].toUpperCase(),
		);
		checkMoodRendering(mood);
	}

	checkBambooFieldMajority("moods", moods);
}

function checkMoodRendering(mood) {
	// `${mood}` se muestra como literal para documentar las dos plantillas del indicador.
	check(
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal `${mood}` mostrado en la etiqueta de la aserción a propósito
		`mood renders in "Pandi ${"${mood}"}": ${JSON.stringify(mood)}`,
		`Pandi ${mood}`.startsWith("Pandi ") && `Pandi ${mood}`.endsWith("…"),
	);
	check(
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal `${mood}` mostrado en la etiqueta de la aserción a propósito
		`mood renders in "Pandi despierto y ${"${mood}"}": ${JSON.stringify(mood)}`,
		`Pandi despierto y ${mood}`.startsWith("Pandi despierto y ") && `Pandi despierto y ${mood}`.endsWith("…"),
	);
}

function checkPicker(moods, pick) {
	let allMembers = true;
	for (let i = 0; i < 300; i++) {
		if (!moods.includes(pick(moods))) {
			allMembers = false;
			break;
		}
	}
	check("pick(MOODS) always returns a member", allMembers);
	check("pick on a single-element array returns that element", pick(["only"]) === "only");
}

function checkQuote(quote) {
	check("PANDI_QUOTE has two lines", Array.isArray(quote) && quote.length === 2);
	check(
		"PANDI_QUOTE lines are non-empty strings",
		quote.every((line) => typeof line === "string" && line.trim().length > 0),
	);
}

function checkGreetings(greetings, quote) {
	check("GREETINGS is a non-empty array", Array.isArray(greetings) && greetings.length > 0, String(greetings?.length));
	check("GREETINGS has no duplicates", new Set(greetings).size === greetings.length);
	for (const greeting of greetings) {
		check(
			`greeting is a non-empty string: ${JSON.stringify(greeting)}`,
			typeof greeting === "string" && greeting.length > 1,
		);
		check(`greeting is trimmed: ${JSON.stringify(greeting)}`, greeting === greeting.trim());
		check(
			`greeting starts uppercase (a sentence): ${JSON.stringify(greeting)}`,
			greeting[0] === greeting[0].toUpperCase() && greeting[0] !== greeting[0].toLowerCase(),
		);
		check(`greeting ends with sentence punctuation: ${JSON.stringify(greeting)}`, /[.…]$/.test(greeting));
		check(
			`greeting never repeats the splash phrase: ${JSON.stringify(greeting)}`,
			!greeting.includes(quote[0]) && !greeting.includes(quote[1]),
		);
	}
	checkBambooFieldMajority("greetings", greetings);
}

function checkGreetingText(greetingText, greetings, quote) {
	// Con splash visible, la cita vive en el encabezado; sin splash, el saludo la conserva.
	check("greetingText is a function", typeof greetingText === "function");
	const flavor = greetings[0];
	const withSplash = greetingText(true, flavor);
	const withoutSplash = greetingText(false, flavor);
	check("greetingText(splashVisible=true) says 'Pandi listo.'", withSplash.includes("Pandi listo."));
	check(
		`greetingText(splashVisible=true) includes the flavor line: ${JSON.stringify(withSplash)}`,
		withSplash.includes(flavor),
	);
	check(
		`greetingText(splashVisible=true) does NOT repeat the main phrase: ${JSON.stringify(withSplash)}`,
		!withSplash.includes(quote[0]) && !withSplash.includes(quote[1]),
	);
	check(
		"greetingText(splashVisible=false) DOES carry the main phrase",
		withoutSplash.includes(quote[0]) && withoutSplash.includes(quote[1]),
	);
	check(
		"greetingText returns a trimmed, non-empty string in both modes",
		withSplash.trim() === withSplash &&
			withSplash.length > 0 &&
			withoutSplash.trim() === withoutSplash &&
			withoutSplash.length > 0,
	);
}

function checkBambooFieldMajority(label, list) {
	const inField = list.filter((item) => FIELD_VOCAB.some((word) => fold(item).includes(word)));
	check(
		`a strong majority of ${label} are in the bamboo-forest field (>=60%): ${inField.length}/${list.length}`,
		inField.length / list.length >= 0.6,
		`${inField.length}/${list.length}`,
	);
}

function fold(value) {
	return value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();
}

main().catch((error) => {
	console.error(error);
	process.exit(2);
});
