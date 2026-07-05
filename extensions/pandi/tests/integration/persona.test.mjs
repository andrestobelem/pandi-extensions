#!/usr/bin/env node
/**
 * Test de comportamiento durable para el bloque puro de persona de extensions/pandi
 * (persona.ts).
 *
 * pandi agrega este bloque al FINAL del system prompt (vía before_agent_start) para darle
 * al asistente la voz suave, de bosque de bambú, de Pandi, incluida la firma 🐼 que le gusta
 * al usuario. Esta suite fija el contrato para que el agregado siga bien formado y en tono.
 *
 * Contrato:
 * - PANDI_PERSONA_TAG es un identificador simple, seguro para XML (solo letras/guion bajo).
 * - pandiPersonaBlock() envuelve el texto de la persona en <TAG> … </TAG> (abre primero,
 *   cierra al final).
 * - El bloque nombra a "Pandi" y lleva la firma 🐼 de la que trata la persona.
 * - El cuerpo del bloque (entre las etiquetas) no está vacío y está trimmeado.
 * - El hábito del 🐼 está enmarcado como OCCASIONAL, no en cada mensaje (para que siga
 *   siendo un condimento).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function scenarioPersonaUnit(url) {
	const { PANDI_PERSONA, PANDI_PERSONA_TAG, pandiPersonaBlock } = await loadModule(url);

	check(
		"PANDI_PERSONA_TAG is a simple identifier",
		typeof PANDI_PERSONA_TAG === "string" && /^[a-z_]+$/.test(PANDI_PERSONA_TAG),
		String(PANDI_PERSONA_TAG),
	);
	check(
		"PANDI_PERSONA is a non-empty trimmed string",
		typeof PANDI_PERSONA === "string" && PANDI_PERSONA.trim() === PANDI_PERSONA && PANDI_PERSONA.length > 0,
	);

	const block = pandiPersonaBlock();
	check("pandiPersonaBlock opens with the persona tag", block.startsWith(`<${PANDI_PERSONA_TAG}>`));
	check("pandiPersonaBlock closes with the persona tag", block.endsWith(`</${PANDI_PERSONA_TAG}>`));

	const inner = block.slice(`<${PANDI_PERSONA_TAG}>`.length, block.length - `</${PANDI_PERSONA_TAG}>`.length).trim();
	check("persona block has a non-empty body", inner.length > 0);
	check("persona block names Pandi", inner.includes("Pandi"));
	check("persona block carries the 🐼 signature", inner.includes("🐼"));
	check(
		"persona frames the 🐼 as occasional, not every message",
		/cada tanto|no en cada|de vez en cuando|ocasional/i.test(inner),
	);
	// Rasgos de carácter: creativo, didáctico y conciso (pedido el 2026-07-04). La persona
	// debe llevar los tres, y honrar "conciso" también en sí misma: todo el bloque sigue
	// siendo un condimento, no un ensayo (evita que el crecimiento de rasgos infle el system
	// prompt).
	check("persona carries the creative trait", /creativ/i.test(inner), inner);
	check("persona carries the didactic trait", /didáctic/i.test(inner), inner);
	check("persona carries the concise trait", /concis/i.test(inner), inner);
	check(
		"persona still guards accuracy over style (condimento rule)",
		/condimento|nunca sacrifiques/i.test(inner),
		inner,
	);
	check(`persona stays concise itself (≤ 7 lines, got ${inner.split("\n").length})`, inner.split("\n").length <= 7);
	check(`persona stays concise itself (≤ 600 chars, got ${inner.length})`, inner.length <= 600);
}

async function main() {
	const built = await buildExtension({
		name: "pandi-persona",
		src: path.join(REPO_ROOT, "extensions", "pandi", "persona.ts"),
		outName: "persona.mjs",
	});
	try {
		await scenarioPersonaUnit(built.url);
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
