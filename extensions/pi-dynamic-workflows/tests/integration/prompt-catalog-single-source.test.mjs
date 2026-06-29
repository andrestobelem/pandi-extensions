/**
 * Single-source-of-truth GUARDIAN for the "Research-backed templates" prompt block.
 *
 * Why this file exists
 * --------------------
 * The runtime CANONICAL source of the workflow pattern catalog is
 * `formatWorkflowPatternCatalog()` in extensions/pi-dynamic-workflows/templates.ts.
 * The same "Research-backed templates" block is mirrored, for human docs, in three
 * places:
 *   - extensions/pi-dynamic-workflows/README.md   (## Research-backed templates)
 *   - README.md (repo root)                        (### Research-backed templates)
 *   - .pi/skills/dynamic-workflows/SKILL.md        (## Research-backed templates)
 *
 * Those copies are byte-identical to the canonical block today (modulo the heading
 * level ##/### and trailing whitespace). `npm test` is otherwise a typecheck +
 * behavior suite; nothing pins these doc mirrors, so any future edit to the catalog
 * wording would silently drift the docs out of sync (DRY violation for prompts).
 *
 * This test enforces the single source: it extracts the block from each doc,
 * canonicalizes (strip the leading `#`/`##`/`###` on the heading line, trim per-line
 * trailing whitespace, drop trailing blank lines) and asserts it equals the same
 * block produced by `formatWorkflowPatternCatalog()`. If you intentionally change
 * the wording, update templates.ts AND the three docs together and this stays green.
 *
 * Run directly:
 *   node extensions/pi-dynamic-workflows/tests/integration/prompt-catalog-single-source.test.mjs
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const HEADING = "Research-backed templates";
const CLOSING = "Use these as patterns, not ceremony";

// templates.ts has NO external imports, so it bundles standalone (no stubs needed).
async function buildTemplates() {
	// templates.ts has no peer-dependency imports, so no stubs are needed.
	const { url } = await sharedBuildExtension({
		name: "pi-dwf-prompt-ssot",
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "templates.ts"),
		outName: "templates.mjs",
		npx: "--yes",
	});
	return url;
}

/**
 * Slice the block from its heading line through the CLOSING line (inclusive).
 * Returns null if the markers are not found.
 */
function sliceBlock(text) {
	const lines = text.split("\n");
	const start = lines.findIndex((l) => l.replace(/^#+\s*/, "").trim() === HEADING);
	if (start === -1) return null;
	let end = -1;
	for (let i = start; i < lines.length; i++) {
		if (lines[i].includes(CLOSING)) {
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
		throw new Error("formatWorkflowPatternCatalog is not exported from templates.ts");
	}

	const canonicalBlock = sliceBlock(mod.formatWorkflowPatternCatalog());
	check("canonical: block present in formatWorkflowPatternCatalog()", canonicalBlock !== null);
	if (!canonicalBlock) {
		console.log(`\nTOTAL: ${failures} failed`);
		process.exit(1);
	}
	const canonical = canonicalize(canonicalBlock);

	const docs = ["extensions/pi-dynamic-workflows/README.md", "README.md", ".pi/skills/dynamic-workflows/SKILL.md"];
	for (const rel of docs) {
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
