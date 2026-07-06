/**
 * GUARDIÁN de packaging (repo-wide): cada extensión debe shippear sus propios módulos .ts runtime
 * para una instalación STANDALONE (`pi install ./extensions/<ext>` / `npm pack ./extensions/<ext>`).
 *
 * Por qué existe este archivo
 * --------------------------
 * Pi carga cada extensión autocontenida: su `index.ts` importa módulos `.ts` sibling de profundidad uno
 * (p. ej. `./job-runtime.js` -> job-runtime.ts). Esos siblings solo resuelven cuando el paquete npm
 * realmente los SHIPPEA. Un `package.json` cuyo `files[]` lista solo `index.ts`
 * (o un subset incompleto) publica un paquete standalone roto: los siblings runtime están
 * ausentes y la resolución de módulos falla al cargar.
 *
 * El paquete ROOT del monorepo (`pandi-dynamic-workflows`) shippea cada `extensions/<ext>/<file>.ts`, así que el
 * tarball ROOT está bien. Este guardián protege el OTRO contrato: publish standalone
 * por extensión (un requisito real — ver regla self-contained-extension de AGENTS.md + memory).
 *
 * Invariante aplicado acá (mínimo + determinista, sin spawn de npm):
 *   Para cada extensión bajo extensions/ (excepto `shared`, que es solo test-harness),
 *   cada archivo runtime `*.ts` de profundidad uno en la raíz de la extensión DEBE estar cubierto por su
 *   `package.json` `files[]` (listado exacto o matcheado por un glob como `*.ts`).
 *   Los archivos de test viven bajo tests/ y NO se shippean intencionalmente, así que solo cuentan los .ts ROOT.
 *
 * El fix Karpathy-clean que satisface esto para siempre es `files: ["*.ts", "README.md", ...]`
 * por extensión, así los siblings nuevos nunca rompen silenciosamente el paquete standalone de nuevo.
 *
 * Corré directo:
 *   node extensions/pandi-dynamic-workflows/tests/integration/standalone-packaging.test.mjs
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

// Glob mínimo de npm-files: solo las formas de directorio inicial que realmente usamos ("*.ts", "*",
// nombres exactos). Los patrones npm `files` sin slash matchean la raíz del paquete; un "*.ts" pelado
// por lo tanto cubre cada .ts root-level. Esto es deliberadamente chico: no un globber completo.
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
			continue; // no es un paquete
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
