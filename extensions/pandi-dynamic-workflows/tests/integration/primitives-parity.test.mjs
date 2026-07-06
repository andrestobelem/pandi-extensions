#!/usr/bin/env node
/**
 * Test durable de paridad: la referencia primitives/*.md se mantiene 1:1 con los globals
 * inyectados REALES del runtime de dynamic-workflow de pi.
 *
 * Fuente de verdad = las asignaciones `sandbox.<name> = …` en worker-source.ts (el set
 * exacto de nombres que un script de workflow puede llamar). primitives/ es la referencia
 * humana derivada; este test protege contra drift en AMBAS direcciones:
 *   - un global agregado en worker-source.ts sin primitives/<name>.md → FAIL
 *   - un primitives/<name>.md sin global inyectado correspondiente → FAIL
 *
 * También fija una SHAPE uniforme de docs (para que cada primitive se documente igual)
 * y un control negativo (para que la extracción no pueda matchear nada en silencio).
 *
 * Sin build de extensión / sin modelo: filesystem puro + regex sobre worker-source.ts.
 *
 * Ejecutalo:
 *   node extensions/pandi-dynamic-workflows/tests/integration/primitives-parity.test.mjs
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const WORKER = path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "worker-source.ts");
const PRIM_DIR = path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "primitives");
// Mirror autocontenido del skill: una copia byte-idéntica para que el skill ultracode funcione standalone
// (instalado sin la extensión). Se mantiene en sync acá — más estricto que el snapshot claude-workflows.
const MIRROR_DIR = path.join(REPO_ROOT, ".pi", "skills", "ultracode", "reference", "primitives");

const { check, counts } = createChecker();

/** Extrae el set de globals inyectados: `sandbox.<name> = …`, excluyendo internos con prefijo `_`. */
function injectedGlobals(source) {
	const names = new Set();
	for (const m of source.matchAll(/sandbox\.([A-Za-z][A-Za-z0-9]*)\s*=/g)) names.add(m[1]);
	return names;
}

function main() {
	const source = fs.readFileSync(WORKER, "utf8");
	const globals = injectedGlobals(source);

	// Control negativo: la extracción debe ser no vacua e incluir un sentinel conocido.
	check("extraction is non-vacuous", globals.size >= 20, `found=${globals.size}`);
	check("extraction includes sentinel 'agent'", globals.has("agent"), [...globals].join(","));

	// primitives/ debe existir con un .md por global (excluyendo README.md).
	const dirExists = fs.existsSync(PRIM_DIR) && fs.statSync(PRIM_DIR).isDirectory();
	check("primitives/ directory exists", dirExists, PRIM_DIR);
	if (!dirExists) {
		return finish();
	}

	const docNames = new Set(
		fs
			.readdirSync(PRIM_DIR)
			.filter((f) => f.endsWith(".md") && f !== "README.md")
			.map((f) => f.slice(0, -3)),
	);

	// Paridad 1:1, reportada en AMBAS direcciones.
	const missing = [...globals].filter((g) => !docNames.has(g)).sort();
	const stale = [...docNames].filter((d) => !globals.has(d)).sort();
	check("every injected global has a primitives/<name>.md", missing.length === 0, `missing: ${missing.join(", ")}`);
	check("no primitives/<name>.md without an injected global", stale.length === 0, `stale: ${stale.join(", ")}`);

	// El índice README debe existir y linkear cada primitive.
	const readmePath = path.join(PRIM_DIR, "README.md");
	const hasReadme = fs.existsSync(readmePath);
	check("primitives/README.md index exists", hasReadme, readmePath);
	if (hasReadme) {
		const readme = fs.readFileSync(readmePath, "utf8");
		const unlinked = [...globals].filter((g) => !readme.includes(`${g}.md`)).sort();
		check("README links every primitive", unlinked.length === 0, `not linked: ${unlinked.join(", ")}`);
	}

	// SHAPE uniforme de docs: heading, línea Runtime y sección Example.
	for (const name of [...docNames].sort()) {
		const doc = fs.readFileSync(path.join(PRIM_DIR, `${name}.md`), "utf8");
		const firstHeading = (doc.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "").trim();
		const shapeOk = firstHeading.startsWith("# ") && /\*\*Runtime:\*\*/.test(doc) && /^##+\s+Example/m.test(doc);
		check(`${name}.md has the required shape (# heading, **Runtime:**, ## Example)`, shapeOk, firstHeading);
	}

	// Mirror del skill: copia byte-idéntica de toda la carpeta canónica (README.md incluido).
	const mirrorExists = fs.existsSync(MIRROR_DIR) && fs.statSync(MIRROR_DIR).isDirectory();
	check("skill mirror reference/primitives/ exists", mirrorExists, MIRROR_DIR);
	if (mirrorExists) {
		const canon = fs
			.readdirSync(PRIM_DIR)
			.filter((f) => f.endsWith(".md"))
			.sort();
		const mirror = fs
			.readdirSync(MIRROR_DIR)
			.filter((f) => f.endsWith(".md"))
			.sort();
		check(
			"skill mirror has the same file set as canonical",
			canon.join(",") === mirror.join(","),
			`canon=${canon.length} mirror=${mirror.length}`,
		);
		const differ = canon.filter(
			(f) =>
				!mirror.includes(f) ||
				fs.readFileSync(path.join(PRIM_DIR, f), "utf8") !== fs.readFileSync(path.join(MIRROR_DIR, f), "utf8"),
		);
		check("skill mirror is byte-identical to canonical", differ.length === 0, `drifted: ${differ.join(", ")}`);
	}

	finish();
}

function finish() {
	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		console.log(`Failures:\n  - ${counts.failures.join("\n  - ")}`);
		process.exit(1);
	}
}

main();
