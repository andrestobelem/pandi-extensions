#!/usr/bin/env node
// sync-skill-mirrors.mjs — espeja copias byte-idénticas de SKILL.md desde el canónico
// `.pi/skills/<name>/SKILL.md` (fuente de verdad) hacia `.claude/skills/<name>/SKILL.md`, para que
// un skill que debe estar disponible IDÉNTICO en ambos hosts (Pi y Claude Code) no pueda divergir.
//
// Solo se copian los skills listados en MIRRORED. Los skills intencionalmente host-specific
// (por ejemplo `ultracode`, cuyos catalog paths difieren entre pi y claude) NO se listan y se
// mantienen de forma independiente — no los agregues acá.
//
// Esto sigue el patrón de claude-workflows (un generator + un --check protegido por un test de parity):
// editá la copia en .pi y luego re-ejecutá esto; el test de parity
// (extensions/pandi-dynamic-workflows/tests/integration/skill-mirror-parity.test.mjs) falla si hay drift.
//
// Uso:
//   node scripts/sync-skill-mirrors.mjs           # escribe mirrors desde .pi -> .claude
//   node scripts/sync-skill-mirrors.mjs --check    # solo verifica; sale con 1 si hay drift (sin writes)

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readMaybe } from "./lib/sync-file-tree.mjs";
import { discoverSkillClassification, REPO, reportUnclassifiedSkills, SKILLS_ROOT } from "./skill-classification.mjs";

const checkOnly = process.argv.includes("--check");
const classification = discoverSkillClassification();
const MIRRORED = classification.mirrored;

if (checkOnly && reportUnclassifiedSkills("sync-skill-mirrors", classification) > 0) process.exit(1);

let drift = 0;
let wrote = 0;
for (const name of MIRRORED) {
	const src = join(SKILLS_ROOT, name, "SKILL.md");
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
