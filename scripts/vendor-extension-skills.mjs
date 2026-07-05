#!/usr/bin/env node
// vendor-extension-skills.mjs — espeja de forma determinista los skills OWNED por una extensión DESDE
// el canónico `.pi/skills/<name>/` (fuente de verdad) hacia `extensions/<ext>/skills/<name>/`, para que
// la extensión lleve sus propios skills cuando se instala standalone (`pi install ./extensions/<ext>`).
//
// El repo self-hosted carga estos skills vía auto-discovery de `.pi/skills/`; la entrada del paquete
// de la extensión en `.pi/settings.json` filtra skills a `[]` para que la copia vendorizada NO haga
// double-load dentro del repo. Los árboles vendorizados son artifacts GENERATED: no los edites a mano —
// editá la fuente en `.pi` y re-ejecutá esto. Un test de parity protege contra drift
// (extensions/pandi-dynamic-workflows/tests/integration/extension-skills-vendor-parity.test.mjs).
//
// Sigue el patrón existente de generator+--check (sync-skill-mirrors.mjs,
// generate-claude-ultracode-skills.mjs): se copia VERBATIM todo el árbol del skill.
//
// Uso:
//   node scripts/vendor-extension-skills.mjs           # escribe copias vendorizadas desde .pi -> extensión
//   node scripts/vendor-extension-skills.mjs --check   # solo verifica; sale con 1 si hay drift (sin writes)

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { discoverSkillClassification, REPO, reportUnclassifiedSkills, SKILLS_ROOT } from "./skill-classification.mjs";

const SKILLS_SRC = SKILLS_ROOT;
const checkOnly = process.argv.includes("--check");
const classification = discoverSkillClassification();
const VENDOR = classification.vendoredByExtension;

if (checkOnly && reportUnclassifiedSkills("vendor-extension-skills", classification) > 0) process.exit(1);

// Lista recursivamente los archivos bajo `dir` como paths relativos a `dir` (ordenados, estilo POSIX).
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

// Construye el conjunto completo de archivos esperados (path relativo -> contenido) para un árbol de skill vendorizado.
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
			// ¿Los archivos esperados están presentes y son byte-idénticos?
			for (const [rel, want] of expected) {
				const have = await readMaybe(join(outRoot, rel));
				if (have !== want) {
					console.error(`[vendor-extension-skills] ✗ drift: ${ext}/skills/${skillName}/${rel}`);
					drift++;
				}
			}
			// ¿No hay archivos stale que el generador no emitiría?
			for (const rel of await listFilesRec(outRoot)) {
				if (!expected.has(rel)) {
					console.error(`[vendor-extension-skills] ✗ stale (not generated): ${ext}/skills/${skillName}/${rel}`);
					drift++;
				}
			}
			continue;
		}

		// Modo escritura: reescribe el target en limpio para que no queden archivos stale.
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
