#!/usr/bin/env node
/**
 * Test de comportamiento durable para los datos puros y utilidades de extensions/pandi
 * (moods.ts).
 *
 * Fija el contrato de tono/formato del texto de estado rotativo de Pandi para que futuras
 * ediciones sigan siendo coherentes y nunca rompan las dos plantillas que renderiza el
 * indicador de trabajo:
 *   `Pandi ${mood}`              y   `Pandi despierto y ${mood}`
 *
 * Contrato:
 * - MOODS es una lista no vacía y sin duplicados de frases cortas.
 * - Cada mood está trimmeado, empieza en minúscula y termina con un único carácter de
 *   elipsis "…".
 * - Ambas plantillas de renderizado producen strings limpios y no vacíos para cada mood.
 * - La lista se mantiene en el campo semántico de "bosque de bambú" (una fuerte mayoría
 *   de moods referencia vocabulario de panda/bambú/bosque), así que se hace cumplir el
 *   "mismo campo semántico", no solo se afirma en un mensaje de commit.
 * - pick() siempre devuelve un miembro del array (incl. el caso de un solo elemento).
 * - PANDI_QUOTE es una cita de splash de dos líneas y no vacía.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

// Vocabulario que ancla el campo semántico de "bosque de bambú / panda". Un mood cuenta
// como dentro del campo cuando contiene cualquiera de estos tokens (subcadena insensible a
// acentos y mayúsculas/minúsculas).
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
		// Se lee bien en AMBAS plantillas que usa el indicador. Las subcadenas `"${mood}"` son
		// texto literal `${mood}` INTENCIONAL (documentan la plantilla del indicador), no un
		// template literal olvidado; de ahí el biome-ignore puntual antes de cada plantilla.
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

	const inField = MOODS.filter((mood) => FIELD_VOCAB.some((word) => fold(mood).includes(word)));
	check(
		`a strong majority of moods are in the bamboo-forest field (>=60%): ${inField.length}/${MOODS.length}`,
		inField.length / MOODS.length >= 0.6,
		`${inField.length}/${MOODS.length}`,
	);

	// pick() siempre devuelve un miembro del array.
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

	// GREETINGS: líneas tierno/zen de "otra cosa" que se muestran después de "Pandi listo."
	// cuando el splash está visible, para no repetir la frase principal del splash. Son
	// oraciones completas, no los gerundios de MOOD.
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

	// El saludo de arranque NO debe repetir la frase principal del splash cuando el splash
	// está visible (la cita de dos líneas PANDI_QUOTE le corresponde al splash): en su lugar
	// dice "Pandi listo." + una línea flavor tierno/zen. Cuando el splash está oculto, el
	// saludo lleva la cita para que el meme siga apareciendo en algún lado. La aleatoriedad
	// vive en el sitio de llamada (pick), así que greetingText recibe el flavor elegido y se
	// mantiene determinista/testeable.
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

main().catch((error) => {
	console.error(error);
	process.exit(2);
});
