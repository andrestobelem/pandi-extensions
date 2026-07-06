#!/usr/bin/env node
// generate-claude-ultracode-skills.mjs — genera de forma determinista los skills de orquestación
// de Claude Code DESDE el skill canónico dual-platform de pi `.pi/skills/ultracode/` (fuente de verdad).
//
// El skill ultracode de .pi ya describe por sí mismo AMBOS runtimes (Claude Code + pi) en su
// sección "Platform reference", así que su contenido de Claude ya es válido y completo tal cual.
// Desde ahí emitimos dos skills de Claude con una transformación MÍNIMA: solo se renombran el
// campo `name:` del frontmatter y el heading H1 `# `; todo lo demás (prosa, tablas, links) y
// todo el árbol reference/ se copia VERBATIM:
//
//   .pi/skills/ultracode/  ->  .claude/skills/ultracode/         (nombre idéntico)
//                          ->  .claude/skills/dynamic-workflows/ (renombrado)
//
// Las copias de .claude son artifacts GENERATED: no las edites a mano — editá la fuente en .pi y
// re-ejecutá esto. Un test de parity protege contra drift
// (extensions/pandi-dynamic-workflows/tests/integration/claude-ultracode-skills-parity.test.mjs).
//
// Uso:
//   node scripts/generate-claude-ultracode-skills.mjs           # escribe ambos skills desde .pi
//   node scripts/generate-claude-ultracode-skills.mjs --check   # solo verifica; sale con 1 si hay drift

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listFilesRec, readMaybe } from "./lib/sync-file-tree.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO, ".pi", "skills", "ultracode");
const OUT_DIR = join(REPO, ".claude", "skills");

// Nombres de skill emitidos desde la única fuente canónica.
export const TARGETS = ["ultracode", "dynamic-workflows"];

export function parseCheckOnly(args = process.argv.slice(2)) {
	return args.includes("--check");
}

// Transformación mínima pi->claude para SKILL.md: renombra solo el `name:` del frontmatter y el H1.
// Para el target "ultracode" esto es la identidad (el nombre y el heading ya son `ultracode`).
export function transformSkill(src, targetName) {
	return src.replace(/^name: ultracode$/m, `name: ${targetName}`).replace(/^# ultracode$/m, `# ${targetName}`);
}

export function targetRoots(targets = TARGETS, outDir = OUT_DIR) {
	return targets.map((target) => ({ target, outRoot: join(outDir, target) }));
}

// Construye el conjunto completo de archivos esperados (path relativo -> contenido) para un target.
export async function expectedFilesFor(targetName, src = SRC) {
	const files = new Map();
	// SKILL.md (transformado).
	const skill = await readFile(join(src, "SKILL.md"), "utf8");
	files.set("SKILL.md", transformSkill(skill, targetName));
	// árbol reference/ (verbatim).
	const refRel = await listFilesRec(join(src, "reference"));
	for (const rel of refRel) {
		const content = await readFile(join(src, "reference", rel), "utf8");
		files.set(join("reference", rel), content);
	}
	return files;
}

async function checkGeneratedTree(expected, outRoot, target, error) {
	let drift = 0;
	// ¿Los archivos esperados están presentes y son byte-idénticos?
	for (const [rel, want] of expected) {
		const have = await readMaybe(join(outRoot, rel));
		if (have !== want) {
			error(`[gen-claude-ultracode] ✗ drift: ${target}/${rel}`);
			drift++;
		}
	}
	// ¿No hay archivos stale que el generador no emitiría?
	const actual = await listFilesRec(outRoot);
	for (const rel of actual) {
		if (!expected.has(rel)) {
			error(`[gen-claude-ultracode] ✗ stale (not generated): ${target}/${rel}`);
			drift++;
		}
	}
	return drift;
}

async function writeGeneratedTree(expected, outRoot) {
	let wrote = 0;
	// Modo escritura: reescribe el target en limpio para que no queden archivos stale.
	await rm(outRoot, { recursive: true, force: true });
	for (const [rel, content] of expected) {
		const dst = join(outRoot, rel);
		await mkdir(dirname(dst), { recursive: true });
		await writeFile(dst, content);
		wrote++;
	}
	return wrote;
}

export async function syncClaudeUltracodeSkills({
	checkOnly = false,
	targets = TARGETS,
	src = SRC,
	outDir = OUT_DIR,
	log = console.log,
	error = console.error,
} = {}) {
	let drift = 0;
	let wrote = 0;
	for (const { target, outRoot } of targetRoots(targets, outDir)) {
		const expected = await expectedFilesFor(target, src);

		if (checkOnly) {
			drift += await checkGeneratedTree(expected, outRoot, target, error);
			continue;
		}

		const written = await writeGeneratedTree(expected, outRoot);
		wrote += written;
		log(`[gen-claude-ultracode] wrote ${target} (${expected.size} files)`);
	}

	if (checkOnly) {
		if (drift > 0) {
			error(
				`[gen-claude-ultracode] ${drift} file(s) out of sync — run: node scripts/generate-claude-ultracode-skills.mjs`,
			);
			return { drift, wrote, total: targets.length, ok: false };
		}
		log("[gen-claude-ultracode] ✅ both Claude skills in sync with .pi/skills/ultracode.");
	} else {
		log(`[gen-claude-ultracode] ✅ generated ${targets.length} skill(s) (${wrote} files written).`);
	}
	return { drift, wrote, total: targets.length, ok: true };
}

async function main(args = process.argv.slice(2)) {
	const result = await syncClaudeUltracodeSkills({ checkOnly: parseCheckOnly(args) });
	if (!result.ok) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
