#!/usr/bin/env node
// sync-skill-mirrors.mjs — mirror byte-identical SKILL.md copies from the canonical
// `.pi/skills/<name>/SKILL.md` (SOURCE OF TRUTH) to `.claude/skills/<name>/SKILL.md`, so a
// skill that must be available IDENTICALLY in both hosts (Pi and Claude Code) cannot drift.
//
// Only skills listed in MIRRORED are copied. Skills that are intentionally host-specific
// (e.g. `ultracode`, whose catalog paths differ between pi and claude) are NOT listed and are
// maintained independently — do not add them here.
//
// This mirrors the claude-workflows pattern (a generator + a --check guarded by a parity test):
// edit the .pi copy, then re-run this; the parity test
// (extensions/pi-dynamic-workflows/tests/integration/skill-mirror-parity.test.mjs) fails on drift.
//
// Usage:
//   node scripts/sync-skill-mirrors.mjs           # write mirrors from .pi -> .claude
//   node scripts/sync-skill-mirrors.mjs --check    # verify only; exit 1 on drift (no writes)

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Skills that must be byte-identical in .pi/skills AND .claude/skills.
const MIRRORED = [
	"init-pi-dynamic-workflows",
	"ai-assisted-engineering",
	"modern-software-engineering",
	"empirical-software-design",
	"clean-craftsmanship",
	"github-project",
	"pi-cante-releasing",
];

const checkOnly = process.argv.includes("--check");

async function readMaybe(file) {
	try {
		return await readFile(file, "utf8");
	} catch {
		return null;
	}
}

let drift = 0;
let wrote = 0;
for (const name of MIRRORED) {
	const src = join(REPO, ".pi", "skills", name, "SKILL.md");
	const dst = join(REPO, ".claude", "skills", name, "SKILL.md");
	const want = await readMaybe(src);
	if (want === null) {
		console.error(`[sync-skill-mirrors] ✗ missing source: .pi/skills/${name}/SKILL.md`);
		drift++;
		continue;
	}
	const have = await readMaybe(dst);
	if (have === want) continue;
	if (checkOnly) {
		console.error(`[sync-skill-mirrors] ✗ drift: ${name} (.claude copy differs from .pi source)`);
		drift++;
	} else {
		await mkdir(dirname(dst), { recursive: true });
		await writeFile(dst, want);
		console.log(`[sync-skill-mirrors] wrote ${name}`);
		wrote++;
	}
}

if (checkOnly) {
	if (drift > 0) {
		console.error(`[sync-skill-mirrors] ${drift} skill(s) out of sync — run: node scripts/sync-skill-mirrors.mjs`);
		process.exit(1);
	}
	console.log(`[sync-skill-mirrors] ✅ all ${MIRRORED.length} mirrored skill(s) in sync.`);
} else {
	console.log(`[sync-skill-mirrors] ✅ ${MIRRORED.length} mirrored skill(s) synced (${wrote} written).`);
}
