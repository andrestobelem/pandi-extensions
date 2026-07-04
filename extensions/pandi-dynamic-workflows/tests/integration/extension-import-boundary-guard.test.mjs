/**
 * Durable guardian test for the self-contained-extension rule (AGENTS.md): Pi loads each
 * extension standalone (a single file or its own dir), so a runtime `../shared/`-style
 * import only resolves while the whole monorepo is present and BREAKS once the extension
 * is installed on its own. This suite scans every extension's shipped runtime `*.ts` files
 * (the files directly at each extension's root dir under `extensions/`, e.g. `extensions/pandi-goal/` —
 * the `files`/`pi.extensions` surface, NOT `tests/`) and classifies each
 * `import ... from "<spec>"` / `export ... from "<spec>"` specifier:
 *   - `node:*` builtin                                            -> ok
 *   - same-directory-or-below relative (`./...`)                  -> ok (stays inside the ext)
 *   - `../...`                                                    -> ESCAPE (the violation)
 *   - bare package declared in that extension's own package.json
 *     peerDependencies (subpaths match, e.g. "typebox/value")     -> ok
 *   - any other bare package                                      -> undeclared (reported,
 *     not failed — a handful of extensions rely on a peer's own transitive dependency, e.g.
 *     pi-mdview's `typebox` import resolves via @earendil-works/pi-coding-agent's own
 *     dependency; fixing that declaration is a separate, out-of-scope concern from the
 *     directory-escape rule this suite pins).
 *
 * The single behavior-pinning check is the non-vacuous negative control: using the existing
 * `withMutatedFile` harness, it injects a `../shared/runtime.js` import into a real runtime
 * file (extensions/pandi-goal/index.ts), asserts the scanner flags exactly that escape, then
 * reverts — proving the guard actually catches a self-contained-extension-rule violation
 * rather than passing vacuously because the tree happens to be clean today.
 *
 * No extension build / no model: a pure filesystem test.
 *
 * Run it:
 *   node extensions/pandi-dynamic-workflows/tests/integration/extension-import-boundary-guard.test.mjs
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../shared/test/harness.mjs";
import { withMutatedFile } from "../../../shared/test/negative-control.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const EXTENSIONS_DIR = path.join(REPO_ROOT, "extensions");

const { check, counts } = createChecker();

// Matches the specifier of any `import ... from "spec"` / `export ... from "spec"` /
// side-effect `import "spec"` declaration, multiline-safe (some imports wrap across lines).
const FROM_SPECIFIER_RE = /from\s*["']([^"']+)["']/g;
const SIDE_EFFECT_IMPORT_RE = /^\s*import\s*["']([^"']+)["']/gm;
// Dynamic `import("spec")` escapes the directory just as hard as static syntax (finding f3).
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function extractSpecifiers(source) {
	const specs = [];
	for (const m of source.matchAll(FROM_SPECIFIER_RE)) specs.push(m[1]);
	for (const m of source.matchAll(SIDE_EFFECT_IMPORT_RE)) specs.push(m[1]);
	for (const m of source.matchAll(DYNAMIC_IMPORT_RE)) specs.push(m[1]);
	return specs;
}

/** Bare-package base: scoped packages keep their scope ("@scope/pkg" from "@scope/pkg/sub"). */
function packageBase(spec) {
	const parts = spec.split("/");
	return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function classifySpecifier(spec, peerDeps) {
	if (spec.startsWith("node:")) return "ok";
	if (spec.startsWith("../")) return "escape";
	if (spec.startsWith("./")) return "ok";
	return peerDeps.has(packageBase(spec)) ? "ok" : "undeclared";
}

/** List an extension's own root-level runtime *.ts files (no recursion, so tests/ is never included). */
function listRuntimeTsFiles(extDir) {
	return fs
		.readdirSync(extDir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => path.join(extDir, entry.name));
}

function readPeerDeps(extDir) {
	const pkgPath = path.join(extDir, "package.json");
	if (!fs.existsSync(pkgPath)) return new Set();
	const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
	return new Set(Object.keys(pkg.peerDependencies || {}));
}

/** Scan one extension directory; returns [{ file, spec, kind }] for every import/export specifier found. */
function scanExtension(extDir) {
	const peerDeps = readPeerDeps(extDir);
	const results = [];
	for (const file of listRuntimeTsFiles(extDir)) {
		const source = fs.readFileSync(file, "utf8");
		for (const spec of extractSpecifiers(source)) {
			results.push({ file, spec, kind: classifySpecifier(spec, peerDeps) });
		}
	}
	return results;
}

function listExtensionDirs() {
	return fs
		.readdirSync(EXTENSIONS_DIR, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && (entry.name === "pandi" || entry.name.startsWith("pandi-")))
		.map((entry) => path.join(EXTENSIONS_DIR, entry.name));
}

async function main() {
	const extDirs = listExtensionDirs();
	check("found extension directories to scan under extensions/pandi*", extDirs.length > 0, `count=${extDirs.length}`);

	// 1) Real-tree scan: no shipped runtime .ts import escapes its own extension directory.
	const allResults = extDirs.flatMap((dir) => scanExtension(dir));
	const escapes = allResults.filter((r) => r.kind === "escape");
	check(
		"no extension runtime .ts import escapes its own directory (../)",
		escapes.length === 0,
		escapes.map((e) => `${path.relative(REPO_ROOT, e.file)}: ${e.spec}`).join("; "),
	);

	// 2) The classifier genuinely exercises its ALLOW paths (not vacuously never failing):
	// at least one real node:* import and one real declared-peerDependency bare import.
	check(
		"classifier allows real node:* builtin imports found in the tree",
		allResults.some((r) => r.spec.startsWith("node:") && r.kind === "ok"),
	);
	check(
		"classifier allows real declared-peerDependency bare imports found in the tree",
		allResults.some((r) => !r.spec.startsWith("node:") && !r.spec.startsWith(".") && r.kind === "ok"),
	);

	// 3) Negative control: inject a directory-escaping import into a real runtime file and
	// confirm the scanner flags exactly that escape, then revert (crash-safe via withMutatedFile).
	const goalDir = path.join(EXTENSIONS_DIR, "pandi-goal");
	const goalIndexPath = path.join(goalDir, "index.ts");
	await withMutatedFile(
		goalIndexPath,
		(original) => `import { fake } from "../shared/runtime.js";\n${original}`,
		() => {
			const mutatedEscapes = scanExtension(goalDir).filter((r) => r.kind === "escape");
			check(
				"escaping ../shared/runtime.js import injected into pandi-goal/index.ts is flagged",
				mutatedEscapes.length === 1 && mutatedEscapes[0].spec === "../shared/runtime.js",
				JSON.stringify(mutatedEscapes),
			);
		},
	);
	check(
		"pandi-goal/index.ts is restored to zero escapes after the negative control",
		scanExtension(goalDir).filter((r) => r.kind === "escape").length === 0,
	);

	// 4) Negative control (dynamic import): `await import("../…")` escapes the directory just
	// as hard as a static import when the extension is installed standalone — the guard must
	// flag it too (review finding f3: the original scanner only matched static syntax).
	await withMutatedFile(
		goalIndexPath,
		(original) => `const lazy = await import("../shared/lazy.js");\n${original}`,
		() => {
			const mutatedEscapes = scanExtension(goalDir).filter((r) => r.kind === "escape");
			check(
				'escaping dynamic import("../shared/lazy.js") injected into pandi-goal/index.ts is flagged',
				mutatedEscapes.length === 1 && mutatedEscapes[0].spec === "../shared/lazy.js",
				JSON.stringify(mutatedEscapes),
			);
		},
	);
	check(
		"pandi-goal/index.ts is restored to zero escapes after the dynamic-import control",
		scanExtension(goalDir).filter((r) => r.kind === "escape").length === 0,
	);

	if (counts.failed > 0) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

await main();
