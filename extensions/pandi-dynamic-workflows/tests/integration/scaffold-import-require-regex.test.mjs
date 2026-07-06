/**
 * Pin de inspección de source para #27: el regex import/require de validateCode() en
 * workflow-factory false-positivea sobre la palabra "require" dentro de keys `required:`
 * de JSON-schema, así cualquier draft generado que embeba un objeto schema
 * (p. ej. { required: ["x"] }) se rechaza con un error engañoso "uses import/require"
 * aunque nunca importe ni requiera nada.
 *
 * Este test lee el scaffold CANÓNICO (extensions/pandi-dynamic-workflows/scaffolds/
 * workflow-factory.js), extrae el literal RegExp real usado por el check import/require
 * de validateCode(), y lo ejercita directamente contra tres inputs:
 *   1. un string de schema que contiene `required: [...]` — NO debe matchear (hoy SÍ lo hace,
 *      porque /\b(import|require)\s*\(?/ matchea el substring "require" dentro de
 *      "required").
 *   2. un statement real `import ... from ...` — todavía debe matchear.
 *   3. una llamada real `require(...)` — todavía debe matchear.
 *
 * Esto pinea el closure local validateCode() del scaffold, que es un code path SEPARADO
 * de transformWorkflowCode() en index.ts (ese ya usa el /^\s*import\s/m correcto y no
 * tiene ningún check de require — ver write-validates-code.test.mjs y
 * transform-contract.test.mjs, que no están afectados por este bug ni se tocan acá).
 *
 * Mutation-free: lee el source del scaffold y pattern-matchea; nunca lo ejecuta.
 *
 * Ejecutalo:
 *   node extensions/pandi-dynamic-workflows/tests/integration/scaffold-import-require-regex.test.mjs
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createChecker, REPO_ROOT } from "../../../shared/test/harness.mjs";

const { check, counts } = createChecker();

const SCAFFOLDS_DIR = path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "scaffolds");
const factorySrc = fs.readFileSync(path.join(SCAFFOLDS_DIR, "workflow-factory.js"), "utf8");

// Extrae el literal RegExp import/require de validateCode() directamente de todo el
// source (no de una única línea split("\n")), para que un line-wrap del formatter entre el
// guard `.test(s))` y la llamada `problems.push("uses import/require...")` — como hace el
// printer de biome para el regex pineado cuando supera el límite de largo de línea — no pueda
// romper esta extracción. Anclado al mensaje de problema para que una edición futura no relacionada
// en validateCode() no pueda desplazar silenciosamente este test al regex equivocado.
const literalMatch = factorySrc.match(
	/\/((?:\\.|[^/\\])+)\/([a-z]*)\.test\(s\)\)\s*problems\.push\("uses import\/require/,
);
const regexLiteralSrc = literalMatch ? `/${literalMatch[1]}/${literalMatch[2]}` : undefined;
check(
	"validateCode() import/require RegExp literal extracted from the scaffold",
	Boolean(literalMatch),
	'no `<regex>.test(s)) ... problems.push("uses import/require"` construct found in workflow-factory.js',
);

// Reconstruí vía `new RegExp(pattern, flags)` desde los grupos capturados — sin eval().
const importRequireRegex = literalMatch ? new RegExp(literalMatch[1], literalMatch[2]) : /$^/;

const schemaDraft = "const schema = { type: 'object', required: ['x'], properties: {} };";
check(
	"schema draft with `required:` field does NOT false-positive as import/require",
	!importRequireRegex.test(schemaDraft),
	`regex ${regexLiteralSrc} incorrectly matched: ${schemaDraft}`,
);

const realImport = "import fs from 'node:fs';";
check(
	"real `import ... from ...` statement still matches",
	importRequireRegex.test(realImport),
	`regex ${regexLiteralSrc} failed to match: ${realImport}`,
);

const realRequire = "const fs = require('node:fs');";
check(
	"real `require(...)` call still matches",
	importRequireRegex.test(realRequire),
	`regex ${regexLiteralSrc} failed to match: ${realRequire}`,
);

console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
if (counts.failed) {
	console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
	process.exit(1);
}
