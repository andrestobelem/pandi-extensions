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
import { fileURLToPath } from "node:url";
import { readMaybe } from "./lib/sync-file-tree.mjs";
import { discoverSkillClassification, REPO, reportUnclassifiedSkills, SKILLS_ROOT } from "./skill-classification.mjs";

export function parseCheckOnly(args = process.argv.slice(2)) {
	return args.includes("--check");
}

export function mirroredSkillPairs(skillNames, { repo = REPO, skillsRoot = SKILLS_ROOT } = {}) {
	return skillNames.map((name) => ({
		name,
		src: join(skillsRoot, name, "SKILL.md"),
		dst: join(repo, ".claude", "skills", name, "SKILL.md"),
	}));
}

export async function syncSkillMirrors({
	checkOnly = false,
	classification = discoverSkillClassification(),
	repo = REPO,
	skillsRoot = SKILLS_ROOT,
	log = console.log,
	error = console.error,
} = {}) {
	if (checkOnly && reportUnclassifiedSkills("sync-skill-mirrors", classification) > 0) {
		return { drift: classification.unclassified.length, wrote: 0, total: classification.mirrored.length, ok: false };
	}

	let drift = 0;
	let wrote = 0;
	const pairs = mirroredSkillPairs(classification.mirrored, { repo, skillsRoot });
	for (const { name, src, dst } of pairs) {
		const want = await readMaybe(src);
		if (want === null) {
			error(`[sync-skill-mirrors] ✗ missing source: .pi/skills/${name}/SKILL.md`);
			drift++;
			continue;
		}
		const have = await readMaybe(dst);
		if (have === want) continue;
		if (checkOnly) {
			error(`[sync-skill-mirrors] ✗ drift: ${name} (.claude copy differs from .pi source)`);
			drift++;
		} else {
			await mkdir(dirname(dst), { recursive: true });
			await writeFile(dst, want);
			log(`[sync-skill-mirrors] wrote ${name}`);
			wrote++;
		}
	}

	if (checkOnly) {
		if (drift > 0) {
			error(`[sync-skill-mirrors] ${drift} skill(s) out of sync — run: node scripts/sync-skill-mirrors.mjs`);
			return { drift, wrote, total: pairs.length, ok: false };
		}
		log(`[sync-skill-mirrors] ✅ all ${pairs.length} mirrored skill(s) in sync.`);
	} else {
		log(`[sync-skill-mirrors] ✅ ${pairs.length} mirrored skill(s) synced (${wrote} written).`);
	}
	return { drift, wrote, total: pairs.length, ok: true };
}

async function main(args = process.argv.slice(2)) {
	const result = await syncSkillMirrors({ checkOnly: parseCheckOnly(args) });
	if (!result.ok) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
