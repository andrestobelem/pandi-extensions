/**
 * GUARDIÁN de packaging: los scaffolds de runtime deben shipearse en el tarball npm.
 *
 * Por qué existe este archivo
 * --------------------------
 * pattern-scaffolds.ts carga desde disco los scaffolds ejecutables de patterns en runtime
 * vía `readdirSync(SCAFFOLDS_DIR)` (extensions/pandi-dynamic-workflows/scaffolds/*.js), y
 * workflow-resolve.ts carga los workflows built-in como fallback global desde workflows/*.js.
 * Ambos son assets de runtime: `files[]` debe incluirlos tanto en el tarball raíz como en el
 * paquete publicable de la extensión, o una instalación npm falla lejos del checkout.
 *
 * El glob original `files: ["extensions/*\/*.ts", ...]` matcheaba solo un nivel de directorio
 * Y solo `.ts`, así que shipeaba CERO scaffolds (viven dos niveles más abajo, en scaffolds/,
 * y son `.js`). Este test fija ambos assets con `npm pack --dry-run`.
 * npm 11 serializa `--json` como un objeto `{ packageName: entry }`; npm anteriores devuelven
 * `[entry]`. El parser acepta las dos formas para que el guard no dependa del npm de la sesión.
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
const EXTENSION_ROOT = path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows");
const SCAFFOLDS_DIR = path.join(EXTENSION_ROOT, "scaffolds");
const BUNDLED_WORKFLOWS_DIR = path.join(EXTENSION_ROOT, "workflows");

let failures = 0;
function check(name, ok, detail) {
	console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
	if (!ok) {
		failures++;
		if (detail) console.log(`   -> ${String(detail).slice(0, 600)}`);
	}
}

function packedFilePaths(cwd) {
	const res = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	if (res.status !== 0) throw new Error(`npm pack --dry-run failed: ${res.stderr || res.stdout}`);
	const parsed = JSON.parse(res.stdout);
	const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
	return new Set((entry?.files || []).map((file) => file.path.replace(/\\/g, "/")));
}

function main() {
	const scaffolds = readdirSync(SCAFFOLDS_DIR).filter((f) => f.endsWith(".js"));
	check("there are scaffolds on disk to ship", scaffolds.length > 0, `found ${scaffolds.length}`);

	const rootPacked = packedFilePaths(REPO_ROOT);
	const missingScaffolds = scaffolds.filter(
		(file) => !rootPacked.has(`extensions/pandi-dynamic-workflows/scaffolds/${file}`),
	);
	check(
		`all ${scaffolds.length} scaffolds/*.js are in the root npm tarball`,
		missingScaffolds.length === 0,
		missingScaffolds.length
			? `missing ${missingScaffolds.length}: ${missingScaffolds.slice(0, 5).join(", ")}${missingScaffolds.length > 5 ? " …" : ""}`
			: "",
	);

	const workflows = readdirSync(BUNDLED_WORKFLOWS_DIR).filter((file) => file.endsWith(".js"));
	check("there is a bundled workflow on disk to ship", workflows.includes("contract-gate.js"), workflows.join(", "));
	const missingRootWorkflows = workflows.filter(
		(file) => !rootPacked.has(`extensions/pandi-dynamic-workflows/workflows/${file}`),
	);
	check(
		`all ${workflows.length} workflows/*.js are in the root npm tarball`,
		missingRootWorkflows.length === 0,
		missingRootWorkflows.join(", "),
	);

	const extensionPacked = packedFilePaths(EXTENSION_ROOT);
	const missingExtensionWorkflows = workflows.filter((file) => !extensionPacked.has(`workflows/${file}`));
	check(
		`all ${workflows.length} workflows/*.js are in the extension npm tarball`,
		missingExtensionWorkflows.length === 0,
		missingExtensionWorkflows.join(", "),
	);

	console.log(`\nTOTAL: ${failures === 0 ? "all passed" : `${failures} failed`}`);
	process.exit(failures === 0 ? 0 : 1);
}

main();
