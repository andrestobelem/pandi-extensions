/**
 * Packaging GUARDIAN (repo-wide): every extension must ship its own runtime .ts modules
 * for a STANDALONE install (`pi install ./extensions/<ext>` / `npm pack ./extensions/<ext>`).
 *
 * Why this file exists
 * --------------------
 * Pi loads each extension self-contained: its `index.ts` imports depth-one sibling `.ts`
 * modules (e.g. `./job-runtime.js` -> job-runtime.ts). Those siblings only resolve when the
 * npm package actually SHIPS them. A `package.json` whose `files[]` lists only `index.ts`
 * (or an incomplete subset) publishes a broken standalone package: the runtime siblings are
 * absent and module resolution fails on load.
 *
 * The monorepo ROOT package (`pi-dynamic-workflows`) ships every `extensions/<ext>/<file>.ts`, so the ROOT
 * tarball is fine. This guardian protects the OTHER contract: per-extension standalone
 * publish (a real requirement — see AGENTS.md self-contained-extension rule + memory).
 *
 * Invariant enforced here (minimal + deterministic, no npm spawn):
 *   For every extension under extensions/ (except `shared`, which is test-harness only),
 *   every depth-one runtime `*.ts` file in the extension root MUST be covered by its
 *   `package.json` `files[]` (either listed exactly or matched by a glob such as `*.ts`).
 *   Test files live under tests/ and are intentionally NOT shipped, so only ROOT .ts count.
 *
 * The Karpathy-clean fix that satisfies this for all time is `files: ["*.ts", "README.md", ...]`
 * per extension, so newly added siblings never silently re-break the standalone package.
 *
 * Run directly:
 *   node extensions/pi-dynamic-workflows/tests/integration/standalone-packaging.test.mjs
 */

import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const EXTENSIONS_DIR = path.join(REPO_ROOT, "extensions");

let failures = 0;
function check(name, ok, detail) {
	console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
	if (!ok) {
		failures++;
		if (detail) console.log(`   -> ${String(detail).slice(0, 600)}`);
	}
}

// Minimal npm-files glob: only the leading-directory forms we actually use ("*.ts", "*",
// exact names). npm `files` patterns without a slash match the package root; a bare "*.ts"
// therefore covers every root-level .ts. This is deliberately small — not a full globber.
function patternCoversRootFile(pattern, fileName) {
	if (pattern === fileName) return true;
	if (pattern === "*" || pattern === "*.*") return true;
	if (pattern.startsWith("*.")) return fileName.endsWith(pattern.slice(1)); // "*.ts" -> ".ts"
	return false;
}

function rootTsFiles(extDir) {
	return readdirSync(extDir, { withFileTypes: true })
		.filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".d.ts"))
		.map((e) => e.name)
		.sort();
}

function main() {
	const extDirs = readdirSync(EXTENSIONS_DIR, { withFileTypes: true })
		.filter((e) => e.isDirectory() && e.name !== "shared")
		.map((e) => e.name)
		.sort();
	check("there are extensions to audit", extDirs.length > 0, `found ${extDirs.length}`);

	for (const name of extDirs) {
		const extDir = path.join(EXTENSIONS_DIR, name);
		let pkg;
		try {
			pkg = JSON.parse(readFileSync(path.join(extDir, "package.json"), "utf8"));
		} catch {
			continue; // not a package
		}
		const files = Array.isArray(pkg.files) ? pkg.files : [];
		const tsFiles = rootTsFiles(extDir);
		const missing = tsFiles.filter((f) => !files.some((p) => patternCoversRootFile(p, f)));
		check(
			`extensions/${name}: package.json files[] ships all ${tsFiles.length} root runtime .ts`,
			missing.length === 0,
			missing.length ? `files=${JSON.stringify(files)} missing=${missing.join(", ")}` : "",
		);
	}

	console.log(`\nTOTAL: ${failures === 0 ? "all passed" : `${failures} failed`}`);
	process.exit(failures === 0 ? 0 : 1);
}

main();
