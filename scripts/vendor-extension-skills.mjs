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

import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listFilesRec, readMaybe } from "./lib/sync-file-tree.mjs";
import { discoverSkillClassification, REPO, reportUnclassifiedSkills, SKILLS_ROOT } from "./skill-classification.mjs";

export function parseCheckOnly(args = process.argv.slice(2)) {
	return args.includes("--check");
}

export function vendoredSkillTargets(vendoredByExtension, { repo = REPO } = {}) {
	return Object.entries(vendoredByExtension).flatMap(([ext, skills]) =>
		skills.map((skillName) => ({
			ext,
			skillName,
			outRoot: join(repo, "extensions", ext, "skills", skillName),
		})),
	);
}

// Construye el conjunto completo de archivos esperados (path relativo -> contenido) para un árbol de skill vendorizado.
export async function expectedFilesFor(skillName, skillsRoot = SKILLS_ROOT) {
	const srcRoot = join(skillsRoot, skillName);
	const files = new Map();
	for (const rel of await listFilesRec(srcRoot)) {
		files.set(rel, await readFile(join(srcRoot, rel), "utf8"));
	}
	return files;
}

async function checkGeneratedTree(expected, outRoot, label, error) {
	let drift = 0;
	// ¿Los archivos esperados están presentes y son byte-idénticos?
	for (const [rel, want] of expected) {
		const have = await readMaybe(join(outRoot, rel));
		if (have !== want) {
			error(`[vendor-extension-skills] ✗ drift: ${label}/${rel}`);
			drift++;
		}
	}
	// ¿No hay archivos stale que el generador no emitiría?
	for (const rel of await listFilesRec(outRoot)) {
		if (!expected.has(rel)) {
			error(`[vendor-extension-skills] ✗ stale (not generated): ${label}/${rel}`);
			drift++;
		}
	}
	return drift;
}

async function writeGeneratedTree(expected, outRoot) {
	let wrote = 0;
	for (const [rel, content] of expected) {
		const dst = join(outRoot, rel);
		await mkdir(dirname(dst), { recursive: true });
		await writeFile(dst, content);
		wrote++;
	}
	return wrote;
}

async function makeSiblingTempDir(outRoot, purpose) {
	await mkdir(dirname(outRoot), { recursive: true });
	return mkdtemp(join(dirname(outRoot), `${basename(outRoot)}.${purpose}-`));
}

async function removeBestEffort(removePath, target) {
	try {
		await removePath(target, { recursive: true, force: true });
	} catch {
		// El cleanup no debe ocultar el resultado del swap ni destruir la única copia recuperable.
	}
}

export async function replaceGeneratedTree(
	expected,
	outRoot,
	{ writeTree = writeGeneratedTree, renamePath = rename, removePath = rm } = {},
) {
	const stagingRoot = await makeSiblingTempDir(outRoot, "staging");
	let backupRoot;
	let preserveBackup = false;
	try {
		await writeTree(expected, stagingRoot);
		const stagingDrift = await checkGeneratedTree(expected, stagingRoot, "staging", () => {});
		if (stagingDrift > 0) {
			throw new Error(`[vendor-extension-skills] incomplete staging tree for ${outRoot}`);
		}

		backupRoot = await makeSiblingTempDir(outRoot, "backup");
		await removePath(backupRoot, { recursive: true, force: true });
		try {
			await renamePath(outRoot, backupRoot);
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
			backupRoot = undefined;
		}

		try {
			await renamePath(stagingRoot, outRoot);
		} catch (swapError) {
			if (backupRoot) {
				try {
					await renamePath(backupRoot, outRoot);
					backupRoot = undefined;
				} catch (rollbackError) {
					preserveBackup = true;
					throw new AggregateError(
						[swapError, rollbackError],
						`[vendor-extension-skills] swap and rollback failed; previous tree remains at ${backupRoot}`,
					);
				}
			}
			throw swapError;
		}

		return expected.size;
	} finally {
		await removeBestEffort(removePath, stagingRoot);
		if (backupRoot && !preserveBackup) {
			await removeBestEffort(removePath, backupRoot);
		}
	}
}

export async function syncVendorExtensionSkills({
	checkOnly = false,
	classification = discoverSkillClassification(),
	repo = REPO,
	skillsRoot = SKILLS_ROOT,
	log = console.log,
	error = console.error,
} = {}) {
	if (checkOnly && reportUnclassifiedSkills("vendor-extension-skills", classification) > 0) {
		return { drift: classification.unclassified.length, wrote: 0, treesWritten: 0, ok: false };
	}

	let drift = 0;
	let wrote = 0;
	let treesWritten = 0;
	for (const { ext, skillName, outRoot } of vendoredSkillTargets(classification.vendoredByExtension, { repo })) {
		const expected = await expectedFilesFor(skillName, skillsRoot);
		if (expected.size === 0) {
			error(`[vendor-extension-skills] ✗ missing source: .pi/skills/${skillName}/`);
			drift++;
			continue;
		}

		const label = `${ext}/skills/${skillName}`;
		if (checkOnly) {
			drift += await checkGeneratedTree(expected, outRoot, label, error);
			continue;
		}

		wrote += await replaceGeneratedTree(expected, outRoot);
		treesWritten++;
	}

	if (checkOnly) {
		if (drift > 0) {
			error(
				`[vendor-extension-skills] ${drift} file(s) out of sync — run: node scripts/vendor-extension-skills.mjs`,
			);
			return { drift, wrote, treesWritten, ok: false };
		}
		log("[vendor-extension-skills] ✅ all vendored extension skills in sync with .pi/skills.");
	} else {
		log(`[vendor-extension-skills] ✅ vendored ${treesWritten} skill tree(s) (${wrote} files written).`);
	}
	return { drift, wrote, treesWritten, ok: true };
}

async function main(args = process.argv.slice(2)) {
	const result = await syncVendorExtensionSkills({ checkOnly: parseCheckOnly(args) });
	if (!result.ok) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
