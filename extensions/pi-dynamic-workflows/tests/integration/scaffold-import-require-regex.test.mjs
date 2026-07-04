/**
 * Source-inspection pin for #27: workflow-factory's validateCode() import/require
 * regex false-positives on the word "require" inside JSON-schema `required:` keys,
 * so any generated draft that embeds a schema object (e.g. { required: ["x"] })
 * gets rejected with a misleading "uses import/require" error even though it never
 * imports or requires anything.
 *
 * This test reads the CANONICAL scaffold (extensions/pi-dynamic-workflows/scaffolds/
 * workflow-factory.js), extracts the actual RegExp literal used by validateCode()'s
 * import/require check, and exercises it directly against three inputs:
 *   1. a schema string containing `required: [...]` — must NOT match (today it DOES,
 *      because /\b(import|require)\s*\(?/ matches the "require" substring inside
 *      "required").
 *   2. a real `import ... from ...` statement — must still match.
 *   3. a real `require(...)` call — must still match.
 *
 * This pins the scaffold's local validateCode() closure, which is a SEPARATE code
 * path from transformWorkflowCode() in index.ts (that one already uses the correct
 * /^\s*import\s/m and has no require check at all — see write-validates-code.test.mjs
 * and transform-contract.test.mjs, which are unaffected by this bug and untouched
 * here).
 *
 * Mutation-free: reads the scaffold source and pattern-matches; never executes it.
 *
 * Run it:
 *   node extensions/pi-dynamic-workflows/tests/integration/scaffold-import-require-regex.test.mjs
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createChecker, REPO_ROOT } from "../../../shared/test/harness.mjs";

const { check, counts } = createChecker();

const SCAFFOLDS_DIR = path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "scaffolds");
const factorySrc = fs.readFileSync(path.join(SCAFFOLDS_DIR, "workflow-factory.js"), "utf8");

// Extract the validateCode() import/require RegExp literal directly out of the whole
// source (not a single split("\n") line), so a formatter-driven line-wrap between the
// `.test(s))` guard and the `problems.push("uses import/require...")` call — as biome's
// printer does for the pinned regex once it grows past the line-length limit — cannot
// break this extraction. Anchored on the problem message so a future unrelated edit to
// validateCode() cannot silently drift this test onto the wrong regex.
const literalMatch = factorySrc.match(
	/\/((?:\\.|[^/\\])+)\/([a-z]*)\.test\(s\)\)\s*problems\.push\("uses import\/require/,
);
const regexLiteralSrc = literalMatch ? `/${literalMatch[1]}/${literalMatch[2]}` : undefined;
check(
	"validateCode() import/require RegExp literal extracted from the scaffold",
	Boolean(literalMatch),
	'no `<regex>.test(s)) ... problems.push("uses import/require"` construct found in workflow-factory.js',
);

// Reconstruct via `new RegExp(pattern, flags)` from the captured groups — no eval().
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
