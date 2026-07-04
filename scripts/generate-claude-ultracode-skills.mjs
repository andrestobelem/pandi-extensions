#!/usr/bin/env node
// generate-claude-ultracode-skills.mjs — deterministically generate the Claude Code orchestration
// skills FROM the canonical dual-platform pi skill `.pi/skills/ultracode/` (SOURCE OF TRUTH).
//
// The .pi ultracode skill already self-describes BOTH runtimes (Claude Code + pi) via its
// "Platform reference" section, so it is valid and complete Claude content as-is. We emit two
// Claude skills from it with a MINIMAL transform — only the `name:` frontmatter field and the
// `# ` H1 heading are renamed; everything else (prose, tables, links) and the entire reference/
// tree are copied VERBATIM:
//
//   .pi/skills/ultracode/  ->  .claude/skills/ultracode/         (identity name)
//                          ->  .claude/skills/dynamic-workflows/ (renamed)
//
// The .claude copies are GENERATED artifacts: do NOT hand-edit them — edit the .pi source and
// re-run this. A parity test guards against drift
// (extensions/pandi-dynamic-workflows/tests/integration/claude-ultracode-skills-parity.test.mjs).
//
// Usage:
//   node scripts/generate-claude-ultracode-skills.mjs           # write both skills from .pi
//   node scripts/generate-claude-ultracode-skills.mjs --check   # verify only; exit 1 on drift

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO, ".pi", "skills", "ultracode");
const OUT_DIR = join(REPO, ".claude", "skills");

// Target skill names emitted from the single canonical source.
const TARGETS = ["ultracode", "dynamic-workflows"];

const checkOnly = process.argv.includes("--check");

// Minimal pi->claude transform for SKILL.md: rename only the frontmatter `name:` and the H1.
// For the "ultracode" target this is the identity (name/heading are already `ultracode`).
function transformSkill(src, targetName) {
	return src.replace(/^name: ultracode$/m, `name: ${targetName}`).replace(/^# ultracode$/m, `# ${targetName}`);
}

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

// Build the full set of expected files (relative path -> content) for a target.
async function expectedFilesFor(targetName) {
	const files = new Map();
	// SKILL.md (transformed).
	const skill = await readFile(join(SRC, "SKILL.md"), "utf8");
	files.set("SKILL.md", transformSkill(skill, targetName));
	// reference/ tree (verbatim).
	const refRel = await listFilesRec(join(SRC, "reference"));
	for (const rel of refRel) {
		const content = await readFile(join(SRC, "reference", rel), "utf8");
		files.set(join("reference", rel), content);
	}
	return files;
}

let drift = 0;
let wrote = 0;
for (const target of TARGETS) {
	const outRoot = join(OUT_DIR, target);
	const expected = await expectedFilesFor(target);

	if (checkOnly) {
		// Expected files present and byte-identical?
		for (const [rel, want] of expected) {
			const have = await readMaybe(join(outRoot, rel));
			if (have !== want) {
				console.error(`[gen-claude-ultracode] ✗ drift: ${target}/${rel}`);
				drift++;
			}
		}
		// No stale files the generator would not emit?
		const actual = await listFilesRec(outRoot);
		for (const rel of actual) {
			if (!expected.has(rel)) {
				console.error(`[gen-claude-ultracode] ✗ stale (not generated): ${target}/${rel}`);
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
	console.log(`[gen-claude-ultracode] wrote ${target} (${expected.size} files)`);
}

if (checkOnly) {
	if (drift > 0) {
		console.error(
			`[gen-claude-ultracode] ${drift} file(s) out of sync — run: node scripts/generate-claude-ultracode-skills.mjs`,
		);
		process.exit(1);
	}
	console.log(`[gen-claude-ultracode] ✅ both Claude skills in sync with .pi/skills/ultracode.`);
} else {
	console.log(`[gen-claude-ultracode] ✅ generated ${TARGETS.length} skill(s) (${wrote} files written).`);
}
