/**
 * Single-source-of-truth GUARDIAN for the "Research-backed templates" prompt block.
 *
 * Why this file exists
 * --------------------
 * The runtime CANONICAL source of the workflow pattern catalog is
 * `formatWorkflowPatternCatalog()` in extensions/pandi-dynamic-workflows/pattern-scaffolds.ts.
 * The same "Research-backed templates" block is mirrored, for human docs, in two
 * flavors:
 *   English (byte-identical to the canonical block, modulo heading level):
 *   - extensions/pandi-dynamic-workflows/README.md   (## Research-backed templates)
 *   - .pi/skills/ultracode/SKILL.md                (## Research-backed templates)
 *   Spanish (the human docs are in Spanish since the 2026-07 translation):
 *   - README.md (repo root)                        (### Plantillas apoyadas en research)
 *   - docs/dynamic-workflows.md                    (### Plantillas apoyadas en research)
 *
 * `npm test` is otherwise a typecheck + behavior suite; nothing pins these doc
 * mirrors, so any future edit to the catalog wording would silently drift the docs
 * out of sync (DRY violation for prompts).
 *
 * This test enforces the single source per flavor:
 *   - English mirrors must equal the block produced by `formatWorkflowPatternCatalog()`
 *     (strip the heading level, trim per-line trailing whitespace, drop trailing blanks).
 *   - Spanish mirrors must be byte-identical to EACH OTHER (one Spanish canon; the
 *     root README copy is the reference) and must list the same **bold** pattern
 *     names, in the same order, as the English canonical block (structural parity —
 *     a translation cannot be byte-compared against the English prompt).
 * If you intentionally change the wording, update pattern-scaffolds.ts AND the
 * mirrored docs together and this stays green.
 *
 * Run directly:
 *   node extensions/pandi-dynamic-workflows/tests/integration/prompt-catalog-single-source.test.mjs
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const HEADING = "Research-backed templates";
const CLOSING = "Use these as patterns, not ceremony";
const HEADING_ES = "Plantillas apoyadas en research";
const CLOSING_ES = "Usalos como patterns, no como ceremonia";

// pattern-scaffolds.ts has NO external imports, so it bundles standalone (no stubs needed).
async function buildTemplates() {
	// pattern-scaffolds.ts has no peer-dependency imports, so no stubs are needed.
	const { url } = await sharedBuildExtension({
		name: "pi-dwf-prompt-ssot",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "pattern-scaffolds.ts"),
		outName: "pattern-scaffolds.mjs",
	});
	return url;
}

/**
 * Slice the block from its heading line through the CLOSING line (inclusive).
 * Returns null if the markers are not found.
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

/** Strip heading level, trim per-line trailing whitespace, drop trailing blanks. */
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

	const englishDocs = ["extensions/pandi-dynamic-workflows/README.md", ".pi/skills/ultracode/SKILL.md"];
	for (const rel of englishDocs) {
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

	// Spanish mirrors: one Spanish canon (root README is the reference) + structural
	// parity of the bold pattern names against the English canonical block.
	const spanishDocs = ["README.md", "docs/dynamic-workflows.md"];
	const boldNames = (block) => block.match(/\*\*[^*]+\*\*/g) ?? [];
	const canonicalNames = boldNames(canonical).join(" | ");
	let spanishRef = null;
	for (const rel of spanishDocs) {
		const text = await fs.readFile(path.join(REPO_ROOT, rel), "utf8");
		const block = sliceBlock(text, HEADING_ES, CLOSING_ES);
		check(`${rel}: "${HEADING_ES}" block present`, block !== null);
		if (!block) continue;
		const got = canonicalize(block);
		check(
			`${rel}: bold pattern names match the canonical block (structural parity)`,
			boldNames(got).join(" | ") === canonicalNames,
			`canonical: ${canonicalNames}\n   doc:       ${boldNames(got).join(" | ")}`,
		);
		if (spanishRef === null) {
			spanishRef = { rel, got };
		} else {
			check(
				`${rel}: Spanish block is byte-identical to ${spanishRef.rel}`,
				got === spanishRef.got,
				got === spanishRef.got ? "" : firstDiff(spanishRef.got, got),
			);
		}
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
