/**
 * GUARDIÁN single-source-of-truth para el bloque de prompt "Research-backed templates".
 *
 * Por qué existe este archivo
 * ---------------------------
 * La fuente CANÓNICA runtime del catálogo de patterns de workflow es
 * `formatWorkflowPatternCatalog()` en extensions/pandi-dynamic-workflows/pattern-scaffolds.ts.
 * El mismo bloque "Plantillas apoyadas en research" se espeja en skills/docs humanas
 * y debe mantenerse byte-idéntico salvo nivel de heading:
 *   - .pi/skills/ultracode/SKILL.md                (## Plantillas apoyadas en research)
 *   - extensions/pandi-dynamic-workflows/README.md (### Plantillas apoyadas en research)
 *   - README.md (repo root)                        (### Plantillas apoyadas en research)
 *   - docs/dynamic-workflows.md                    (### Plantillas apoyadas en research)
 *
 * `npm test` por lo demás es una suite de typecheck + comportamiento; nada pinea estos mirrors
 * de docs, así que cualquier edición futura del wording del catálogo desincronizaría silenciosamente
 * las docs (violación DRY para prompts).
 *
 * Este test exige una única fuente: todos los mirrors deben igualar el bloque producido por
 * `formatWorkflowPatternCatalog()` (quitando nivel de heading, trimeando whitespace final por línea
 * y dropeando blanks finales).
 * Si cambiás intencionalmente el wording, actualizá pattern-scaffolds.ts Y las docs espejadas
 * juntas y esto queda verde.
 *
 * Corrida directa:
 *   node extensions/pandi-dynamic-workflows/tests/integration/surface/prompt-catalog.test.mjs
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension as sharedBuildExtension } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

const HEADING = "Plantillas apoyadas en research";
const CLOSING = "Usalos como patterns, no como ceremonia";

// pattern-scaffolds.ts NO tiene imports externos, así que bundlea standalone (sin stubs).
async function buildTemplates() {
	// pattern-scaffolds.ts no tiene imports de peer-dependency, así que no hacen falta stubs.
	const { url } = await sharedBuildExtension({
		name: "pi-dwf-prompt-ssot",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "surface", "pattern-scaffolds.ts"),
		outName: "pattern-scaffolds.mjs",
	});
	return url;
}

/**
 * Cortá el bloque desde su línea de heading hasta la línea CLOSING (inclusive).
 * Devuelve null si no encuentra los marcadores.
 */
function sliceBlock(text, heading = HEADING, closing = CLOSING) {
	const lines = text.split("\n");
	const start = lines.findIndex((l) => l.replace(/^#+\s*/, "").trim() === heading);
	if (start === -1) return null;
	let end = -1;
	for (let i = start; i < lines.length; i++) {
		if (lines[i].includes(closing)) {
			end = i;
			break;
		}
	}
	if (end === -1) return null;
	return lines.slice(start, end + 1).join("\n");
}

/** Quitá nivel de heading, trimmeá whitespace final por línea y dropeá blanks finales. */
function canonicalize(block) {
	const lines = block.split("\n").map((l) => l.replace(/\s+$/, ""));
	lines[0] = lines[0].replace(/^#+\s*/, "");
	while (lines.length && lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
}

let failures = 0;
function check(name, ok, detail) {
	console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
	if (!ok) {
		failures++;
		if (detail) console.log(`   -> ${String(detail).slice(0, 600)}`);
	}
}

async function main() {
	const url = await buildTemplates();
	const mod = await import(url);
	if (typeof mod.formatWorkflowPatternCatalog !== "function") {
		throw new Error("formatWorkflowPatternCatalog is not exported from pattern-scaffolds.ts");
	}

	const canonicalBlock = sliceBlock(mod.formatWorkflowPatternCatalog());
	check("canonical: block present in formatWorkflowPatternCatalog()", canonicalBlock !== null);
	if (!canonicalBlock) {
		console.log(`\nTOTAL: ${failures} failed`);
		process.exit(1);
	}
	const canonical = canonicalize(canonicalBlock);

	const mirrors = [
		".pi/skills/ultracode/SKILL.md",
		"extensions/pandi-dynamic-workflows/README.md",
		"README.md",
		"docs/dynamic-workflows.md",
	];
	for (const rel of mirrors) {
		const text = await fs.readFile(path.join(REPO_ROOT, rel), "utf8");
		const block = sliceBlock(text);
		check(`${rel}: "${HEADING}" block present`, block !== null);
		if (!block) continue;
		const got = canonicalize(block);
		check(
			`${rel}: block matches canonical formatWorkflowPatternCatalog()`,
			got === canonical,
			got === canonical ? "" : firstDiff(canonical, got),
		);
	}

	console.log(`\nTOTAL: ${failures === 0 ? "all passed" : `${failures} failed`}`);
	process.exit(failures === 0 ? 0 : 1);
}

function firstDiff(a, b) {
	const la = a.split("\n");
	const lb = b.split("\n");
	const n = Math.max(la.length, lb.length);
	for (let i = 0; i < n; i++) {
		if (la[i] !== lb[i])
			return `line ${i + 1}:\n  canonical: ${JSON.stringify(la[i])}\n  doc:       ${JSON.stringify(lb[i])}`;
	}
	return "(no line diff?)";
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
