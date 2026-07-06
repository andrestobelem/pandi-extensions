/**
 * Test guardián durable para la regla de extensión autocontenida (AGENTS.md): Pi carga cada
 * extensión standalone (un archivo único o su propio dir), así que un import runtime estilo
 * `../shared/` solo resuelve mientras está presente el monorepo completo y SE ROMPE cuando la extensión
 * se instala por su cuenta. Esta suite escanea los archivos `*.ts` runtime shipeados de cada extensión
 * (los archivos directamente en el dir raíz de cada extensión bajo `extensions/`, p. ej. `extensions/pandi-goal/`:
 * la superficie `files`/`pi.extensions`, NO `tests/`) y clasifica cada specifier
 * `import ... from "<spec>"` / `export ... from "<spec>"`:
 *   - builtin `node:*`                                            -> ok
 *   - relativo same-directory-or-below (`./...`)                  -> ok (queda dentro de la ext)
 *   - `../...`                                                    -> ESCAPE (la violación)
 *   - paquete bare declarado en el package.json propio de esa extensión
 *     peerDependencies (subpaths matchean, p. ej. "typebox/value") -> ok
 *   - cualquier otro paquete bare                                 -> undeclared (reportado,
 *     no fallado: un puñado de extensiones depende de la dependencia transitiva propia de un peer, p. ej.
 *     el import `typebox` de pandi-mdview resuelve vía la propia dependency de @earendil-works/pi-coding-agent;
 *     arreglar esa declaración es una preocupación separada y fuera de scope de la regla
 *     directory-escape que esta suite pinea).
 *
 * El único check que pinea comportamiento es el control negativo no-vacuo: usando el harness existente
 * `withMutatedFile`, inyecta un import `../shared/runtime.js` en un archivo runtime real
 * (extensions/pandi-goal/index.ts), aserta que el scanner marque exactamente ese escape y luego
 * revierte; prueba que el guard realmente atrapa una violación de self-contained-extension-rule
 * en vez de pasar vacuamente porque el árbol justo está limpio hoy.
 *
 * Sin build de extensión / sin modelo: test puro de filesystem.
 *
 * Ejecutalo:
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

// Matchea el specifier de cualquier declaración `import ... from "spec"` / `export ... from "spec"` /
// side-effect `import "spec"`, segura para multilínea (algunos imports wrappean entre líneas).
const FROM_SPECIFIER_RE = /from\s*["']([^"']+)["']/g;
const SIDE_EFFECT_IMPORT_RE = /^\s*import\s*["']([^"']+)["']/gm;
// `import("spec")` dinámico escapa el directorio tan fuerte como la sintaxis estática (hallazgo f3).
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function extractSpecifiers(source) {
	const specs = [];
	for (const m of source.matchAll(FROM_SPECIFIER_RE)) specs.push(m[1]);
	for (const m of source.matchAll(SIDE_EFFECT_IMPORT_RE)) specs.push(m[1]);
	for (const m of source.matchAll(DYNAMIC_IMPORT_RE)) specs.push(m[1]);
	return specs;
}

/** Base de paquete bare: los paquetes scoped conservan su scope ("@scope/pkg" desde "@scope/pkg/sub"). */
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

/** Listá los archivos runtime *.ts root-level propios de una extensión (sin recursión, así tests/ nunca se incluye). */
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

/** Escaneá un dir de extensión; devuelve [{ file, spec, kind }] por cada specifier import/export encontrado. */
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

	// 1) Scan del árbol real: ningún import runtime .ts shipeado escapa su propio directorio de extensión.
	const allResults = extDirs.flatMap((dir) => scanExtension(dir));
	const escapes = allResults.filter((r) => r.kind === "escape");
	check(
		"no extension runtime .ts import escapes its own directory (../)",
		escapes.length === 0,
		escapes.map((e) => `${path.relative(REPO_ROOT, e.file)}: ${e.spec}`).join("; "),
	);

	// 2) El classifier ejercita genuinamente sus rutas ALLOW (no pasa vacuamente por nunca fallar):
	// al menos un import node:* real y un import bare real declarado como peerDependency.
	check(
		"classifier allows real node:* builtin imports found in the tree",
		allResults.some((r) => r.spec.startsWith("node:") && r.kind === "ok"),
	);
	check(
		"classifier allows real declared-peerDependency bare imports found in the tree",
		allResults.some((r) => !r.spec.startsWith("node:") && !r.spec.startsWith(".") && r.kind === "ok"),
	);

	// 3) Control negativo: inyectá un import que escapa directorio en un archivo runtime real y
	// confirmá que el scanner marque exactamente ese escape, luego revertí (crash-safe vía withMutatedFile).
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

	// 4) Control negativo (dynamic import): `await import("../…")` escapa el directorio tan fuerte
	// como un import estático cuando la extensión se instala standalone; el guard también debe
	// marcarlo (hallazgo de review f3: el scanner original solo matcheaba sintaxis estática).
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
