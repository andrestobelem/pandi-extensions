#!/usr/bin/env node
/**
 * Contrato de `formatArtifactPreviewText` (run-report-artifact-viewer.ts): el artifact
 * viewer del run report vuelca cada archivo dentro de un <pre> plano. Para archivos JSONL
 * (un objeto JSON compacto por línea — p. ej. `agents/*.stdout.log`, transcripciones de
 * sesión) eso produce una sola línea gigante ilegible por evento. Este helper detecta
 * "cada línea no vacía parsea como JSON y empieza con { o [" y, en ese caso, re-emite cada
 * línea con JSON.stringify(..., null, 2) separada por una línea en blanco — texto plano
 * legible, sin cambiar el resto del pipeline (sigue siendo un <pre> estático, sin JS
 * cliente). Cualquier archivo que no sea JSONL uniforme pasa sin tocarse.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, loadModule } from "../../../../shared/test/harness.mjs";
import { buildDwfModule } from "../dwf-test-support.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

const { check, counts } = createChecker();

async function main() {
	const { url } = await buildDwfModule({
		name: "pi-dwf-artifact-viewer-jsonl-pretty",
		relPath: "observe/artifact-viewer.ts",
		outName: "run-report-artifact-viewer.mjs",
	});
	const { formatArtifactPreviewText } = await loadModule(url);
	check("formatArtifactPreviewText is exported", typeof formatArtifactPreviewText === "function");

	// JSONL uniforme: cada línea se re-emite pretty, separadas por línea en blanco.
	const jsonl = ['{"type":"session","id":"a"}', '{"type":"agent_start"}', '{"type":"turn_start"}'].join("\n");
	const pretty = formatArtifactPreviewText(jsonl);
	check(
		"JSONL: cada línea queda pretty-printed",
		pretty ===
			[
				'{\n  "type": "session",\n  "id": "a"\n}',
				'{\n  "type": "agent_start"\n}',
				'{\n  "type": "turn_start"\n}',
			].join("\n\n"),
		pretty,
	);
	const roundtripValues = pretty.split("\n\n").map((chunk) => JSON.parse(chunk));
	check(
		"JSONL pretty preserva el mismo contenido (roundtrip)",
		roundtripValues.length === 3 && roundtripValues[0].type === "session" && roundtripValues[2].type === "turn_start",
	);

	// Líneas en blanco intermedias/al final se ignoran, no rompen la detección.
	const jsonlWithBlanks = `${jsonl}\n\n`;
	check(
		"JSONL con línea en blanco final: mismo resultado que sin ella",
		formatArtifactPreviewText(jsonlWithBlanks) === pretty,
	);

	// No-JSONL: texto plano pasa sin tocarse.
	const plainText = "línea 1\nlínea 2 no es json\n";
	check("texto plano no-JSONL pasa sin cambios", formatArtifactPreviewText(plainText) === plainText);

	// Un solo objeto JSON ya pretty-printed (multilínea) NO es JSONL línea-por-línea: cada
	// línea individual (p. ej. `  "a": 1,`) no arranca con { o [, así que pasa sin tocarse.
	const alreadyPretty = JSON.stringify({ a: 1, b: [1, 2] }, null, 2);
	check(
		"JSON ya pretty-printed (multilínea) pasa sin cambios",
		formatArtifactPreviewText(alreadyPretty) === alreadyPretty,
	);

	// Preview truncado a mitad de una línea JSONL: la última línea (parcial, no parsea) se
	// descarta en vez de abortar el formateo entero, y se deja una nota.
	const truncatedTail = jsonl.slice(0, jsonl.length - 5); // corta el cierre de la última línea
	const truncatedPretty = formatArtifactPreviewText(truncatedTail, { truncated: true });
	check(
		"JSONL truncado: las líneas completas se formatean igual",
		truncatedPretty.startsWith(pretty.split("\n\n").slice(0, 2).join("\n\n")),
		truncatedPretty,
	);
	check("JSONL truncado: nota la línea final descartada", /truncad/i.test(truncatedPretty));

	// Sin el flag truncated, la misma entrada partida a mitad de línea no es JSONL válido
	// (la última línea no parsea) → pasa sin tocarse, conservador por defecto.
	check(
		"sin truncated:true, una entrada partida a mitad de línea pasa sin tocarse",
		formatArtifactPreviewText(truncatedTail) === truncatedTail,
	);

	// Vacío: pasa sin tocarse (nada que formatear).
	check("string vacío pasa sin tocarse", formatArtifactPreviewText("") === "");

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
