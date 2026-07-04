#!/usr/bin/env node
// vendor-extension-skills.mjs — deterministically mirror the skills OWNED by an extension FROM the
// canonical `.pi/skills/<name>/` (SOURCE OF TRUTH) into `extensions/<ext>/skills/<name>/`, so the
// extension carries its own skills when installed standalone (`pi install ./extensions/<ext>`).
//
// The self-hosted repo loads these skills via `.pi/skills/` auto-discovery; the extension package
// entry in `.pi/settings.json` filters skills to `[]` so the vendored copy does NOT double-load
// in-repo. The vendored trees are GENERATED artifacts: do NOT hand-edit them — edit the `.pi`
// source and re-run this. A parity test guards against drift
// (extensions/pandi-dynamic-workflows/tests/integration/extension-skills-vendor-parity.test.mjs).
//
// Mirrors the existing generator+--check pattern (sync-skill-mirrors.mjs,
// generate-claude-ultracode-skills.mjs): the whole skill tree is copied VERBATIM.
//
// Usage:
//   node scripts/vendor-extension-skills.mjs           # write vendored copies from .pi -> extension
//   node scripts/vendor-extension-skills.mjs --check   # verify only; exit 1 on drift (no writes)

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_SRC = join(REPO, ".pi", "skills");

// Ownership map: which skills each extension vendors. A skill is owned by the extension it is
// useless without (e.g. the ultracode/router skills need the dynamic-workflows engine).
const VENDOR = {
	"pandi-dynamic-workflows": ["ultracode", "deep-research", "default"],
	// pi-docs renders Markdown with the pandi tokens; the skill carries the canonical
	// tokens/template the converter reads at runtime, so the extension vendors it.
	"pandi-docs": ["pandi-artifact-style"],
};

const checkOnly = process.argv.includes("--check");

// Recursively list files under `dir` as paths relative to `dir` (sorted, POSIX-ish).
async function listFilesRec(dir, base = dir) {
	const out = [];
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await listFilesRec(full, base)));
		else out.push(relative(base, full));
	}
	return out;
}

async function readMaybe(file) {
	try {
		return await readFile(file, "utf8");
	} catch {
		return null;
	}
}

// Build the full set of expected files (relative path -> content) for one vendored skill tree.
async function expectedFilesFor(skillName) {
	const srcRoot = join(SKILLS_SRC, skillName);
	const files = new Map();
	for (const rel of await listFilesRec(srcRoot)) {
		files.set(rel, await readFile(join(srcRoot, rel), "utf8"));
	}
	return files;
}

let drift = 0;
let wrote = 0;
let treesWritten = 0;

for (const [ext, skills] of Object.entries(VENDOR)) {
	for (const skillName of skills) {
		const expected = await expectedFilesFor(skillName);
		if (expected.size === 0) {
			console.error(`[vendor-extension-skills] ✗ missing source: .pi/skills/${skillName}/`);
			drift++;
			continue;
		}
		const outRoot = join(REPO, "extensions", ext, "skills", skillName);

		if (checkOnly) {
			// Expected files present and byte-identical?
			for (const [rel, want] of expected) {
				const have = await readMaybe(join(outRoot, rel));
				if (have !== want) {
					console.error(`[vendor-extension-skills] ✗ drift: ${ext}/skills/${skillName}/${rel}`);
					drift++;
				}
			}
			// No stale files the generator would not emit?
			for (const rel of await listFilesRec(outRoot)) {
				if (!expected.has(rel)) {
					console.error(`[vendor-extension-skills] ✗ stale (not generated): ${ext}/skills/${skillName}/${rel}`);
					drift++;
				}
			}
			continue;
		}

		// Write mode: rewrite the target cleanly so stale files cannot linger.
		await rm(outRoot, { recursive: true, force: true });
		for (const [rel, content] of expected) {
			const dst = join(outRoot, rel);
			await mkdir(dirname(dst), { recursive: true });
			await writeFile(dst, content);
			wrote++;
		}
		treesWritten++;
	}
}

if (checkOnly) {
	if (drift > 0) {
		console.error(
			`[vendor-extension-skills] ${drift} file(s) out of sync — run: node scripts/vendor-extension-skills.mjs`,
		);
		process.exit(1);
	}
	console.log("[vendor-extension-skills] ✅ all vendored extension skills in sync with .pi/skills.");
} else {
	console.log(`[vendor-extension-skills] ✅ vendored ${treesWritten} skill tree(s) (${wrote} files written).`);
}
