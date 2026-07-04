/**
 * Packaging GUARDIAN: the runtime scaffolds must ship in the npm tarball.
 *
 * Why this file exists
 * --------------------
 * pattern-scaffolds.ts loads the executable pattern scaffolds from disk at runtime
 * via `readdirSync(SCAFFOLDS_DIR)` (extensions/pandi-dynamic-workflows/scaffolds/*.js)
 * and THROWS `Workflow scaffold missing for pattern ...` when a catalog pattern has
 * no file. package.json `files[]` therefore MUST include those .js files, or an
 * npm-installed copy breaks on every scaffold request (new/start/run from a pattern).
 *
 * The original `files: ["extensions/*\/*.ts", ...]` glob matched only one directory
 * level AND only `.ts`, so it shipped ZERO of the scaffolds (they live two levels
 * deep under scaffolds/ and are `.js`). This test pins the fix by asserting that
 * `npm pack --dry-run` includes every scaffolds/*.js file that exists on disk.
 *
 * Run directly:
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
	// --json prints a JSON array on stdout; npm notices go to stderr.
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
