#!/usr/bin/env node
// generate-claude-workflows.mjs — deterministically generate .claude/workflows/*.js
// (Claude Code top-level-script dialect) FROM the canonical pi scaffolds
// (extensions/pi-dynamic-workflows/scaffolds/*.js).
//
// pi scaffolds are the SOURCE OF TRUTH. The Claude files are generated artifacts:
// do NOT hand-edit them — edit the pi scaffold and re-run this. A parity test
// (tests/.../claude-parity) guards against drift.
//
// Transform (the only real pi->claude delta; see git history / plan):
//   1. Entry-point: unwrap `export default async function main() { <body> }` to a
//      top-level body ending in `return` (Claude requires top-level scripts; it
//      rejects export-default-main — verified empirically).
//   2. Catalog-prose: rewrite the .pi/workflows + ~/.pi/agent/workflows catalog
//      references/wording to the Claude equivalents (only router/contract-gate/
//      workflow-factory contain these).
//   3. Re-format with prettier (parser: babel — biome cannot parse top-level return).
// Everything else (template literals, ?., ??, meta incl. basedOn, logic) is kept.
//
// Usage:
//   node .claude/scripts/generate-claude-workflows.mjs           # write all
//   node .claude/scripts/generate-claude-workflows.mjs --check   # verify, exit 1 on drift

import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const SRC_DIR = join(REPO, "extensions", "pi-dynamic-workflows", "scaffolds");
const OUT_DIR = join(REPO, ".claude", "workflows");

const PRETTIER_OPTS = {
	parser: "babel",
	useTabs: true,
	tabWidth: 3,
	printWidth: 120,
	semi: true,
	singleQuote: false,
	trailingComma: "all",
	arrowParens: "always",
};

// Catalog-prose rewrites (pi -> claude). Each `find` is a distinctive verbatim
// substring that occurs in exactly one scaffold; applied globally is safe.
const CATALOG_REWRITES = [
	// router.js — header block comment (spans two comment lines)
	[
		"reading the catalog (the project .pi/workflows/*.js and the global\n * ~/.pi/agent/workflows/*.js), excluding",
		"reading the catalog (~/.claude/workflows/*.js and, if present, ./.claude/\n * workflows/*.js), excluding",
	],
	// router.js — catalog discovery prompt
	[
		"EXISTING pi dynamic workflows available to dispatch to. Read the project catalog at .pi/workflows/*.js and, if it exists, the global catalog at ~/.pi/agent/workflows/*.js.",
		"EXISTING Claude Code dynamic workflows available to dispatch to. Read the user catalog at ~/.claude/workflows/*.js and, if it exists, the project catalog at ./.claude/workflows/*.js.",
	],
	// workflow-factory.js — catalog discovery prompt
	[
		"EXISTING pi dynamic workflows available to reuse/compose. Read the project catalog at .pi/workflows/*.js and, if it exists, the global catalog at ~/.pi/agent/workflows/*.js.",
		"EXISTING Claude Code dynamic workflows available to reuse/compose. Read the user catalog at ~/.claude/workflows/*.js and, if it exists, the project catalog at .claude/workflows/*.js.",
	],
	// workflow-factory.js — draft path (comment + code), shared substring
	[".pi/workflows/drafts/", ".claude/workflows/drafts/"],
	// contract-gate.js — read-pattern prompt (preserve pi's TWO-path read: global + project-local)
	[
		"First read .pi/workflows/${routing.pattern}.js (or the global ~/.pi/agent/workflows/${routing.pattern}.js) and extract",
		"First read ~/.claude/workflows/${routing.pattern}.js (or the project ./.claude/workflows/${routing.pattern}.js) and extract",
	],
];

const WRAP_RE = /^export default async function main\(\)\s*\{\s*$/;

function unwrapMain(src, name) {
	const lines = src.split("\n");
	const wrapIdx = lines.findIndex((l) => WRAP_RE.test(l));
	if (wrapIdx === -1) throw new Error(`${name}: no \`export default async function main() {\` wrapper found`);
	let closeIdx = -1;
	for (let i = lines.length - 1; i > wrapIdx; i--) {
		if (lines[i] === "}") {
			closeIdx = i;
			break;
		}
	}
	if (closeIdx === -1) throw new Error(`${name}: no top-level closing \`}\` found after wrapper`);
	// main() must be the LAST top-level construct — fail loudly if a future scaffold adds
	// code after it (the backward "last bare }" anchor would otherwise silently drop it).
	for (let i = closeIdx + 1; i < lines.length; i++) {
		if (lines[i].trim() !== "") throw new Error(`${name}: unexpected top-level code after main() close (line ${i + 1})`);
	}
	const head = lines.slice(0, wrapIdx); // license/header comments + export const meta
	const body = lines.slice(wrapIdx + 1, closeIdx); // function body (over-indented; prettier fixes)
	return [...head, ...body].join("\n");
}

function applyCatalogRewrites(src) {
	let out = src;
	for (const [find, replace] of CATALOG_REWRITES) out = out.split(find).join(replace);
	return out;
}

async function generateOne(name, src) {
	const rewritten = applyCatalogRewrites(src);
	const unwrapped = unwrapMain(rewritten, name);
	const formatted = await prettier.format(unwrapped, PRETTIER_OPTS);
	// Safety net: no pi-runtime catalog token may survive into a Claude artifact.
	// Bare forms too (no `~/`): catch any surviving pi-runtime catalog reference.
	for (const token of [".pi/workflows", ".pi/agent/workflows", "EXISTING pi dynamic"]) {
		if (formatted.includes(token)) throw new Error(`${name}: pi catalog token survived rewrite: "${token}"`);
	}
	return formatted;
}

async function main() {
	const check = process.argv.includes("--check");
	const files = (await readdir(SRC_DIR)).filter((f) => f.endsWith(".js")).sort();
	let drift = 0;
	let wrote = 0;
	for (const f of files) {
		const src = await readFile(join(SRC_DIR, f), "utf8");
		const generated = await generateOne(f, src);
		const outPath = join(OUT_DIR, f);
		let current = null;
		try {
			current = await readFile(outPath, "utf8");
		} catch {}
		if (check) {
			if (current !== generated) {
				console.error(`  drift: .claude/workflows/${f}`);
				drift++;
			}
		} else if (current !== generated) {
			await writeFile(outPath, generated);
			console.log(`  wrote: .claude/workflows/${f}`);
			wrote++;
		}
	}
	if (check) {
		if (drift > 0) {
			console.error(`[generate-claude-workflows] ❌ ${drift}/${files.length} out of date — run without --check.`);
			process.exit(1);
		}
		console.log(`[generate-claude-workflows] ✅ all ${files.length} in sync.`);
	} else {
		console.log(`[generate-claude-workflows] done — ${wrote} written, ${files.length - wrote} unchanged.`);
	}
}

main().catch((e) => {
	console.error("[generate-claude-workflows] ERROR:", e.message);
	process.exit(2);
});
