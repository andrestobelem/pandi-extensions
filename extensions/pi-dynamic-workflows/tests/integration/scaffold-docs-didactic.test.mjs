#!/usr/bin/env node
/**
 * Guardian for the didactic standard of docs/scaffolds (issue #42).
 *
 * The didactic style contract (.pi/skills/didactic-docs-style/SKILL.md) fixes a required
 * shape for every scaffold page. This suite keeps that standard from eroding under future
 * edits/generations:
 *  - catalog parity BOTH ways: every scaffold in extensions/pi-dynamic-workflows/scaffolds/
 *    has a docs/scaffolds/<key>.md page, and no orphan pages exist;
 *  - each page: H1 `# <key>` on line 1, a `>` blurb quote, the required H2 sections in
 *    canonical order, and a ```mermaid fence;
 *  - index.md links every documented scaffold.
 * Non-vacuity is proven with crash-safe negative controls (withMutatedFile): dropping a
 * section, breaking the order, or removing an index link must make the checker report it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../shared/test/harness.mjs";
import { withMutatedFile } from "../../../shared/test/negative-control.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SCAFFOLDS_DIR = path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "scaffolds");
const DOCS_DIR = path.join(REPO_ROOT, "docs", "scaffolds");

const { check, counts } = createChecker();

// Canonical section order from the tracked style contract (didactic-docs-style skill).
const REQUIRED_SECTIONS = [
	"## En 30 segundos",
	"## Cómo lanzarlo",
	"## Diagrama",
	"## Qué hace",
	"## Cuándo usarlo",
	"## Cómo funciona",
	"## Input y output",
	"## Fases",
];

// Pure checker over the on-disk tree; returns a list of human-readable problems.
function checkScaffoldDocs() {
	const problems = [];
	const keys = fs
		.readdirSync(SCAFFOLDS_DIR)
		.filter((f) => f.endsWith(".js"))
		.map((f) => f.slice(0, -3))
		.sort();
	const pages = fs
		.readdirSync(DOCS_DIR)
		.filter((f) => f.endsWith(".md") && f !== "index.md")
		.map((f) => f.slice(0, -3))
		.sort();

	for (const key of keys) if (!pages.includes(key)) problems.push(`missing page: docs/scaffolds/${key}.md`);
	for (const page of pages) if (!keys.includes(page)) problems.push(`orphan page (no scaffold): ${page}.md`);

	for (const key of pages.filter((p) => keys.includes(p))) {
		const body = fs.readFileSync(path.join(DOCS_DIR, `${key}.md`), "utf8");
		const lines = body.split("\n");
		if (lines[0] !== `# ${key}`) problems.push(`${key}.md: first line must be '# ${key}' (got '${lines[0]}')`);
		if (!lines.some((l) => l.startsWith("> "))) problems.push(`${key}.md: missing blurb quote ('> ...')`);
		if (!body.includes("```mermaid")) problems.push(`${key}.md: missing \`\`\`mermaid fence`);
		const headings = lines.filter((l) => l.startsWith("## "));
		let cursor = -1;
		for (const section of REQUIRED_SECTIONS) {
			const at = headings.indexOf(section);
			if (at === -1) problems.push(`${key}.md: missing section '${section}'`);
			else if (at < cursor) problems.push(`${key}.md: section '${section}' out of canonical order`);
			else cursor = at;
		}
	}

	const indexPath = path.join(DOCS_DIR, "index.md");
	if (!fs.existsSync(indexPath)) problems.push("missing docs/scaffolds/index.md");
	else {
		const index = fs.readFileSync(indexPath, "utf8");
		for (const key of pages) {
			if (!index.includes(`(./${key}.md)`)) problems.push(`index.md: missing link to ./${key}.md`);
		}
	}
	return problems;
}

async function main() {
	// 1) The real tree conforms to the contract.
	const problems = checkScaffoldDocs();
	check("docs/scaffolds conforms to the didactic contract", problems.length === 0, problems.join(" | "));

	// 2) Negative controls: the checker is non-vacuous (crash-safe in-place mutations).
	const victim = path.join(DOCS_DIR, "map-reduce.md");
	await withMutatedFile(
		victim,
		(orig) => orig.replace("## Fases", "## Etapas"),
		() => {
			const p = checkScaffoldDocs();
			check(
				"dropping a required section is reported",
				p.some((x) => x.includes("map-reduce.md") && x.includes("## Fases")),
				p.join(" | "),
			);
		},
	);
	await withMutatedFile(
		victim,
		(orig) => orig.replace("```mermaid", "```text"),
		() => {
			const p = checkScaffoldDocs();
			check(
				"removing the mermaid fence is reported",
				p.some((x) => x.includes("map-reduce.md") && x.includes("mermaid")),
				p.join(" | "),
			);
		},
	);
	await withMutatedFile(
		path.join(DOCS_DIR, "index.md"),
		(orig) => orig.replaceAll("(./map-reduce.md)", "(./map-reduce.html)"),
		() => {
			const p = checkScaffoldDocs();
			check(
				"a missing index link is reported",
				p.some((x) => x.includes("index.md") && x.includes("map-reduce")),
				p.join(" | "),
			);
		},
	);
	// Section order: swap 'Qué hace' after 'Cuándo usarlo' by renaming across both.
	await withMutatedFile(
		victim,
		(orig) =>
			orig
				.replace("## Qué hace", "## TMP")
				.replace("## Cuándo usarlo", "## Qué hace")
				.replace("## TMP", "## Cuándo usarlo"),
		() => {
			const p = checkScaffoldDocs();
			check(
				"out-of-order sections are reported",
				p.some((x) => x.includes("map-reduce.md") && x.includes("order")),
				p.join(" | "),
			);
		},
	);
	// Restored cleanly: the real tree passes again after the controls.
	check("tree restored after negative controls", checkScaffoldDocs().length === 0);

	if (counts.failed > 0) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
