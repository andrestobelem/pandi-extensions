#!/usr/bin/env node
// sync-claude-global.mjs — espeja los assets de este repo orientados a Claude dentro de un home
// GLOBAL de Claude Code para que una sesión global de `claude` tenga workflows, skills, el script
// helper de runtime y la referencia de primitives de ultracode actualizados del proyecto.
//
// FUENTE DE VERDAD = este repo. El destino por defecto es ~/.claude y puede inyectarse vía
// `--dest <dir>` o `CLAUDE_GLOBAL_DIR` (así los tests corren contra un tmp dir descartable, nunca $HOME).
//
// Set gestionado (repo -> <dest>):
//   - .claude/workflows/*                      -> <dest>/workflows/         (todos los .js + README)
//   - .claude/scripts/build-workflow-artifact.mjs -> <dest>/scripts/        (helper runtime de Claude)
//   - .claude/scripts/lib/*                    -> <dest>/scripts/lib/     (sus dependencias runtime)
//   - .claude/skills/<PROJECT_SKILLS>/         -> <dest>/skills/<name>/      (recursivo)
//   - .pi/skills/ultracode/reference/primitives/* -> <dest>/skills/ultracode/reference/primitives/
//         (docs canónicos de primitives; cada uno trae **Runtime:** para que un lector de Claude vea cuáles son
//          pi-only. Sale de .pi para no tocar nunca el skill .claude que puede estar editándose en paralelo.)
//
// SEGURIDAD: status es el default y nunca escribe. Install registra paths + hashes en un manifiesto propio;
// remove solo borra archivos que siguen byte-idénticos a ese registro. Contenido ajeno o modificado se conserva.
//
// Uso:
//   node scripts/sync-claude-global.mjs status          # default read-only; --check es alias compatible
//   node scripts/sync-claude-global.mjs install         # instala/actualiza y registra ownership
//   node scripts/sync-claude-global.mjs remove          # saca solo archivos gestionados sin cambios
//   node scripts/sync-claude-global.mjs --dest <dir>    # apunta a un home explícito (los tests usan esto)

import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSkillClassification, reportUnclassifiedSkills, SKILLS_ROOT } from "./skill-classification.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const classification = discoverSkillClassification();

// Skills de Claude propiedad del proyecto para publicar globalmente. El set propio del repo sale de la
// clasificación compartida de skills; los skills local-only y gitignored (por ejemplo open-prose) quedan como
// extras best-effort: se sincronizan si están presentes en disco y simplemente faltan en CI. Los skills
// global-only (por ejemplo supacode-cli) quedan intactos. Los skills EXTERNAL (por ejemplo karpathy-guidelines,
// desde multica-ai/andrej-karpathy-skills) NO se vendorizan acá — el onboarding los instala globalmente
// desde upstream, así que no se republican.
const PROJECT_SKILLS = [...classification.global, ...classification.optionalClaudeGlobalSkills];
const ACTIONS = new Set(["status", "install", "remove"]);
const MANIFEST_OWNER = "pandi-extensions";
const MANIFEST_VERSION = 1;
export const MANIFEST_NAME = ".pandi-extensions-managed.json";

export function parseArgs(argv, env = process.env, homeDir = homedir()) {
	let action = null;
	let dest = env.CLAUDE_GLOBAL_DIR || join(homeDir, ".claude");
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--dest") {
			const value = argv[i + 1];
			if (!value || value.startsWith("-") || ACTIONS.has(value)) throw new Error("--dest requires a directory");
			dest = argv[++i];
		} else if (arg === "--check" || ACTIONS.has(arg)) {
			const nextAction = arg === "--check" ? "status" : arg;
			if (action && action !== nextAction) throw new Error("choose exactly one action: status, install, or remove");
			action = nextAction;
		} else {
			throw new Error(`unknown argument '${arg}'; expected status, install, or remove`);
		}
	}
	return { action: action ?? "status", dest: resolve(dest) };
}

/** Lista recursivamente los archivos bajo `dir`, como paths relativos a `dir` (estilo POSIX). Vacío si falta. */
export function walk(dir) {
	if (!existsSync(dir)) return [];
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(abs).map((p) => join(entry.name, p)));
		else if (entry.isFile()) out.push(entry.name);
	}
	return out;
}

/** Construye la lista plana de pares de archivos absolutos {src, dst} a la que expande el manifiesto. */
export function planPairs(dest, { repoRoot = REPO, skillsRoot = SKILLS_ROOT, projectSkills = PROJECT_SKILLS } = {}) {
	const pairs = [];
	const addTree = (srcDir, dstDir, skippedPrefix) => {
		for (const rel of walk(srcDir)) {
			if (skippedPrefix && (rel === skippedPrefix || rel.startsWith(`${skippedPrefix}${sep}`))) continue;
			pairs.push({ src: join(srcDir, rel), dst: join(dstDir, rel) });
		}
	};

	// workflows (plano: *.js + README)
	addTree(join(repoRoot, ".claude", "workflows"), join(dest, "workflows"));

	// script helper de runtime (archivo único) más su árbol de dependencias lib/ — el CLI importa
	// ./lib/artifact.mjs, etc., así que ambos deben caer juntos para que la copia global resuelva.
	const rtScript = join(repoRoot, ".claude", "scripts", "build-workflow-artifact.mjs");
	if (existsSync(rtScript)) pairs.push({ src: rtScript, dst: join(dest, "scripts", "build-workflow-artifact.mjs") });
	const rtLib = join(repoRoot, ".claude", "scripts", "lib");
	if (existsSync(rtLib)) addTree(rtLib, join(dest, "scripts", "lib"));

	// skills del proyecto (recursivo)
	for (const name of projectSkills) {
		addTree(
			join(repoRoot, ".claude", "skills", name),
			join(dest, "skills", name),
			name === "ultracode" ? join("reference", "primitives") : undefined,
		);
	}

	// referencia de primitives, tomada desde el mirror canónico de .pi
	addTree(
		join(skillsRoot, "ultracode", "reference", "primitives"),
		join(dest, "skills", "ultracode", "reference", "primitives"),
	);

	return pairs;
}

function sha256(content) {
	return createHash("sha256").update(content).digest("hex");
}

function relativeKey(dest, dst) {
	const rel = relative(dest, dst);
	if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
		throw new Error(`managed path escapes destination: ${dst}`);
	}
	return rel.split(sep).join("/");
}

function destinationForKey(dest, key) {
	const parts = typeof key === "string" ? key.split("/") : [];
	if (
		parts.length === 0 ||
		parts.some((part) => !part || part === "." || part === ".." || part.includes("\\")) ||
		key.toLowerCase() === MANIFEST_NAME.toLowerCase()
	) {
		throw new Error(`invalid managed path in ${MANIFEST_NAME}: ${String(key)}`);
	}
	const dst = resolve(dest, ...parts);
	relativeKey(dest, dst);
	return dst;
}

function lstatOrNull(file) {
	try {
		return lstatSync(file);
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		if (error?.code === "ENOTDIR") {
			throw new Error(`managed path has a non-directory ancestor: ${file}`, { cause: error });
		}
		throw error;
	}
}

function hasSymlinkSegment(dest, key) {
	let current = dest;
	for (const part of key.split("/")) {
		current = join(current, part);
		const stat = lstatOrNull(current);
		if (!stat) return false;
		if (stat.isSymbolicLink()) return true;
	}
	return false;
}

function readManifest(dest) {
	const file = join(dest, MANIFEST_NAME);
	const stat = lstatOrNull(file);
	if (!stat) return null;
	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw new Error(`${MANIFEST_NAME} is not a regular file`);
	}
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`cannot read ${MANIFEST_NAME}`, { cause: error });
	}
	if (parsed?.owner !== MANIFEST_OWNER || parsed?.version !== MANIFEST_VERSION || !Array.isArray(parsed.files)) {
		throw new Error(`unsupported ${MANIFEST_NAME}`);
	}
	const seen = new Set();
	for (const entry of parsed.files) {
		if (
			typeof entry?.path !== "string" ||
			typeof entry?.sha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(entry.sha256) ||
			seen.has(entry.path)
		) {
			throw new Error(`invalid ownership entry in ${MANIFEST_NAME}`);
		}
		destinationForKey(dest, entry.path);
		seen.add(entry.path);
	}
	return parsed;
}

function writeManifest(dest, files) {
	mkdirSync(dest, { recursive: true });
	const file = join(dest, MANIFEST_NAME);
	const stat = lstatOrNull(file);
	if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
		throw new Error(`refusing to replace unsafe manifest ${file}`);
	}
	writeFileSync(file, `${JSON.stringify({ owner: MANIFEST_OWNER, version: MANIFEST_VERSION, files }, null, 2)}\n`);
}

function desiredEntries(dest, pairs) {
	return pairs.map(({ src, dst }) => ({
		path: relativeKey(dest, dst),
		sha256: sha256(readFileSync(src)),
	}));
}

function status(dest, pairs) {
	const manifest = readManifest(dest);
	const owned = new Map((manifest?.files ?? []).map((entry) => [entry.path, entry.sha256]));
	const desired = desiredEntries(dest, pairs);
	const desiredPaths = new Set(desired.map((entry) => entry.path));
	let drift = 0;
	for (const entry of desired) {
		const dst = destinationForKey(dest, entry.path);
		const stat = lstatOrNull(dst);
		const validFile =
			stat?.isFile() && !hasSymlinkSegment(dest, entry.path) && sha256(readFileSync(dst)) === entry.sha256;
		if (owned.get(entry.path) !== entry.sha256 || !validFile) {
			console.error(`[sync-claude-global] ✗ drift: ${entry.path}`);
			drift++;
		}
	}
	for (const entry of manifest?.files ?? []) {
		if (desiredPaths.has(entry.path)) continue;
		console.error(`[sync-claude-global] ✗ stale managed file: ${entry.path}`);
		drift++;
	}
	if (drift > 0) {
		const ownership = manifest ? "managed install is stale" : "ownership manifest is absent";
		console.error(
			`[sync-claude-global] ${drift} file(s) out of sync at ${dest} (${ownership}) — run: npm run sync:claude:global:install`,
		);
		return false;
	}
	console.log(`[sync-claude-global] ✅ installed and in sync at ${dest} (${pairs.length} current managed files).`);
	return true;
}

function install(dest, pairs) {
	const previous = readManifest(dest);
	const entries = desiredEntries(dest, pairs);
	const previouslyOwned = new Map((previous?.files ?? []).map((entry) => [entry.path, entry.sha256]));
	const desiredPaths = new Set(entries.map((entry) => entry.path));
	const writes = [];
	const staleRemovals = [];
	const conflicts = [];
	for (let i = 0; i < pairs.length; i++) {
		const { dst } = pairs[i];
		const entry = entries[i];
		const stat = lstatOrNull(dst);
		if (hasSymlinkSegment(dest, entry.path) || (stat && !stat.isFile())) {
			conflicts.push(entry.path);
			continue;
		}
		if (!stat) {
			writes.push(i);
			continue;
		}
		const haveHash = sha256(readFileSync(dst));
		const previousHash = previouslyOwned.get(entry.path);
		if (!previousHash) conflicts.push(entry.path);
		else if (haveHash === entry.sha256) continue;
		else if (previousHash === haveHash) writes.push(i);
		else conflicts.push(entry.path);
	}
	for (const entry of previous?.files ?? []) {
		if (desiredPaths.has(entry.path)) continue;
		const dst = destinationForKey(dest, entry.path);
		const stat = lstatOrNull(dst);
		if (!stat) continue;
		if (hasSymlinkSegment(dest, entry.path) || !stat.isFile() || sha256(readFileSync(dst)) !== entry.sha256) {
			conflicts.push(entry.path);
		} else {
			staleRemovals.push(dst);
		}
	}
	if (conflicts.length > 0) {
		for (const file of conflicts) console.error(`[sync-claude-global] preserved unowned or modified file: ${file}`);
		console.error(`[sync-claude-global] install aborted before writes (${conflicts.length} conflict(s)).`);
		return false;
	}
	for (const file of staleRemovals) unlinkSync(file);
	for (const file of staleRemovals.sort((a, b) => b.length - a.length)) removeEmptyParents(dest, file);
	let wrote = 0;
	for (const i of writes) {
		const { src, dst } = pairs[i];
		const want = readFileSync(src);
		mkdirSync(dirname(dst), { recursive: true });
		writeFileSync(dst, want);
		wrote++;
	}
	const files = entries.toSorted((a, b) => a.path.localeCompare(b.path));
	writeManifest(dest, files);
	console.log(`[sync-claude-global] ✅ installed ${entries.length} managed files into ${dest} (${wrote} written).`);
	return true;
}

function removeEmptyParents(dest, file) {
	let current = dirname(file);
	while (current !== dest) {
		try {
			rmdirSync(current);
		} catch (error) {
			if (error?.code === "ENOENT") {
				current = dirname(current);
				continue;
			}
			if (error?.code === "ENOTEMPTY" || error?.code === "EEXIST") return;
			throw error;
		}
		current = dirname(current);
	}
}

function remove(dest) {
	const manifest = readManifest(dest);
	if (!manifest) {
		console.log(`[sync-claude-global] no managed Claude globals installed at ${dest}; nothing to remove.`);
		return true;
	}
	let removed = 0;
	const preserved = [];
	const removedPaths = [];
	for (const entry of manifest.files) {
		const dst = destinationForKey(dest, entry.path);
		const stat = lstatOrNull(dst);
		if (!stat) continue;
		const safe = !hasSymlinkSegment(dest, entry.path) && stat.isFile() && sha256(readFileSync(dst)) === entry.sha256;
		if (!safe) {
			preserved.push(entry);
			console.error(`[sync-claude-global] preserved modified or unsafe managed file: ${entry.path}`);
			continue;
		}
		unlinkSync(dst);
		removedPaths.push(dst);
		removed++;
	}
	for (const file of removedPaths.sort((a, b) => b.length - a.length)) removeEmptyParents(dest, file);
	if (preserved.length > 0) {
		writeManifest(dest, preserved);
		console.error(
			`[sync-claude-global] removed ${removed} managed file(s); preserved ${preserved.length} modified or unsafe file(s).`,
		);
		return false;
	}
	unlinkSync(join(dest, MANIFEST_NAME));
	console.log(
		`[sync-claude-global] ✅ removed ${removed} managed files from ${dest}; unrelated files were preserved.`,
	);
	return true;
}

function main() {
	try {
		const { action, dest } = parseArgs(process.argv.slice(2));
		if (action === "remove") {
			if (!remove(dest)) process.exitCode = 1;
			return;
		}
		if (reportUnclassifiedSkills("sync-claude-global", classification) > 0) {
			process.exitCode = 1;
			return;
		}
		const pairs = planPairs(dest);
		if (pairs.length === 0) throw new Error("no source files found — is this the repo root?");
		const ok = action === "install" ? install(dest, pairs) : status(dest, pairs);
		if (!ok) process.exitCode = 1;
	} catch (error) {
		console.error(`[sync-claude-global] ✗ ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
