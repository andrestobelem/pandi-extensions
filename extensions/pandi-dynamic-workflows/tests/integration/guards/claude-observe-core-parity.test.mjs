#!/usr/bin/env node
/**
 * .claude/scripts/lib/observe-core.mjs es un artifact GENERADO (bundle esbuild del renderer
 * canónico observe/html.ts de pi). Este guard rebuildea el bundle desde la fuente TS y lo
 * byte-compara contra la copia commiteada: si alguien edita el .mjs a mano, o cambia el TS
 * sin re-correr el generador, esto falla. Mismo patrón que claude-parity (scaffolds).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createChecker } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const GENERATOR = path.join(REPO_ROOT, "scripts", "generate-claude-observe-core.mjs");
const OUT = path.join(REPO_ROOT, ".claude", "scripts", "lib", "observe-core.mjs");

const { check, counts } = createChecker();

const { buildBundle } = await import(pathToFileURL(GENERATOR).href);
const rebuilt = buildBundle();
const committed = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : null;

check(
	"observe-core.mjs existe (correr node scripts/generate-claude-observe-core.mjs si falta)",
	committed !== null,
	OUT,
);
check(
	"observe-core.mjs es byte-idéntico a un rebuild fresco desde observe/html.ts",
	committed === rebuilt,
	committed === null
		? "missing"
		: `committed ${committed.length} bytes vs rebuilt ${rebuilt.length} bytes — re-corré el generador`,
);

// El bundle debe seguir siendo un módulo cargable con el contrato de exports esperado.
const core = await import(pathToFileURL(OUT).href);
for (const name of ["buildRunReportHtml", "buildRunMermaidSource", "escapeHtml", "PANDI_TOKENS_CSS"]) {
	check(`el bundle exporta ${name}`, name in core, Object.keys(core).join(", "));
}

if (counts.failed > 0) {
	console.error("\nFailures:");
	for (const failure of counts.failures) console.error(`- ${failure}`);
	process.exit(1);
}
console.log(`\n${counts.passed} checks passed`);
