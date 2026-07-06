/**
 * GUARDIÁN de packaging: los scaffolds de runtime deben shipearse en el tarball npm.
 *
 * Por qué existe este archivo
 * --------------------------
 * pattern-scaffolds.ts carga desde disco los scaffolds ejecutables de patterns en runtime
 * vía `readdirSync(SCAFFOLDS_DIR)` (extensions/pandi-dynamic-workflows/scaffolds/*.js)
 * y LANZA `Workflow scaffold missing for pattern ...` cuando un pattern del catálogo no
 * tiene archivo. Por eso `files[]` de package.json DEBE incluir esos archivos .js, o una
 * copia instalada desde npm se rompe en cada pedido de scaffold (new/start/run desde un pattern).
 *
 * El glob original `files: ["extensions/*\/*.ts", ...]` matcheaba solo un nivel de directorio
 * Y solo `.ts`, así que shipeaba CERO scaffolds (viven dos niveles más abajo, en scaffolds/,
 * y son `.js`). Este test fija el arreglo asertando que `npm pack --dry-run` incluye todos
 * los archivos scaffolds/*.js que existen en disco.
 *
 * Ejecutalo directamente:
 *   node extensions/pandi-dynamic-workflows/tests/integration/packaging-scaffolds.test.mjs
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SCAFFOLDS_DIR = path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "scaffolds");

let failures = 0;
function check(name, ok, detail) {
	console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
	if (!ok) {
		failures++;
		if (detail) console.log(`   -> ${String(detail).slice(0, 600)}`);
	}
}

function packedFilePaths() {
	const res = spawnSync("npm", ["pack", "--dry-run", "--json"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	if (res.status !== 0) throw new Error(`npm pack --dry-run failed: ${res.stderr || res.stdout}`);
	// --json imprime un array JSON en stdout; los avisos de npm van a stderr.
	const parsed = JSON.parse(res.stdout);
	const entry = Array.isArray(parsed) ? parsed[0] : parsed;
	return new Set((entry?.files || []).map((f) => f.path.replace(/\\/g, "/")));
}

function main() {
	const scaffolds = readdirSync(SCAFFOLDS_DIR).filter((f) => f.endsWith(".js"));
	check("there are scaffolds on disk to ship", scaffolds.length > 0, `found ${scaffolds.length}`);

	const packed = packedFilePaths();
	const missing = scaffolds.filter((f) => !packed.has(`extensions/pandi-dynamic-workflows/scaffolds/${f}`));
	check(
		`all ${scaffolds.length} scaffolds/*.js are in the npm tarball`,
		missing.length === 0,
		missing.length
			? `missing ${missing.length}: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? " …" : ""}`
			: "",
	);

	console.log(`\nTOTAL: ${failures === 0 ? "all passed" : `${failures} failed`}`);
	process.exit(failures === 0 ? 0 : 1);
}

main();
