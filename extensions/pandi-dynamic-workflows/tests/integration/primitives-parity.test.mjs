#!/usr/bin/env node
/**
 * Durable parity test: the primitives/*.md reference is kept 1:1 with the ACTUAL
 * injected globals of the pi dynamic-workflow runtime.
 *
 * Source of truth = the `sandbox.<name> = …` assignments in worker-source.ts (the
 * exact set of names a workflow script can call). primitives/ is the derived human
 * reference; this test guards against drift in BOTH directions:
 *   - a global added in worker-source.ts with no primitives/<name>.md → FAIL
 *   - a primitives/<name>.md with no matching injected global → FAIL
 *
 * It also pins a uniform doc SHAPE (so every primitive is documented the same way)
 * and a negative control (so the extraction can't silently match nothing).
 *
 * No extension build / no model: pure filesystem + a regex over worker-source.ts.
 *
 * Run it:
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
// Self-contained skill mirror: a byte-identical copy so the ultracode skill works standalone
// (installed without the extension). Kept in sync here — stricter than the claude-workflows snapshot.
const MIRROR_DIR = path.join(REPO_ROOT, ".pi", "skills", "ultracode", "reference", "primitives");

const { check, counts } = createChecker();

/** Extract the injected-globals set: `sandbox.<name> = …`, excluding internal `_`-prefixed ones. */
function injectedGlobals(source) {
	const names = new Set();
	for (const m of source.matchAll(/sandbox\.([A-Za-z][A-Za-z0-9]*)\s*=/g)) names.add(m[1]);
	return names;
}

function main() {
	const source = fs.readFileSync(WORKER, "utf8");
	const globals = injectedGlobals(source);

	// Negative control: extraction must be non-vacuous and include a known sentinel.
	check("extraction is non-vacuous", globals.size >= 20, `found=${globals.size}`);
	check("extraction includes sentinel 'agent'", globals.has("agent"), [...globals].join(","));

	// primitives/ must exist with one .md per global (README.md excluded).
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

	// 1:1 parity, reported in BOTH directions.
	const missing = [...globals].filter((g) => !docNames.has(g)).sort();
	const stale = [...docNames].filter((d) => !globals.has(d)).sort();
	check("every injected global has a primitives/<name>.md", missing.length === 0, `missing: ${missing.join(", ")}`);
	check("no primitives/<name>.md without an injected global", stale.length === 0, `stale: ${stale.join(", ")}`);

	// README index must exist and link every primitive.
	const readmePath = path.join(PRIM_DIR, "README.md");
	const hasReadme = fs.existsSync(readmePath);
	check("primitives/README.md index exists", hasReadme, readmePath);
	if (hasReadme) {
		const readme = fs.readFileSync(readmePath, "utf8");
		const unlinked = [...globals].filter((g) => !readme.includes(`${g}.md`)).sort();
		check("README links every primitive", unlinked.length === 0, `not linked: ${unlinked.join(", ")}`);
	}

	// Uniform doc SHAPE: heading, Runtime line, and an Example section.
	for (const name of [...docNames].sort()) {
		const doc = fs.readFileSync(path.join(PRIM_DIR, `${name}.md`), "utf8");
		const firstHeading = (doc.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "").trim();
		const shapeOk = firstHeading.startsWith("# ") && /\*\*Runtime:\*\*/.test(doc) && /^##+\s+Example/m.test(doc);
		check(`${name}.md has the required shape (# heading, **Runtime:**, ## Example)`, shapeOk, firstHeading);
	}

	// Skill mirror: byte-identical copy of the whole canonical folder (README.md included).
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
