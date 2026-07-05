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
// SEGURIDAD: solo aditivo — SIN prune. El contenido global no gestionado (por ejemplo, un skill global-only
// como supacode-cli) nunca se elimina. `--check` compara sin escribir y sale con 1 si hay drift.
//
// Uso:
//   node scripts/sync-claude-global.mjs                 # escribe en ~/.claude
//   node scripts/sync-claude-global.mjs --check         # solo verifica; sale con 1 si hay drift (sin writes)
//   node scripts/sync-claude-global.mjs --dest <dir>    # apunta a un home explícito (los tests usan esto)

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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

function parseArgs(argv) {
	const checkOnly = argv.includes("--check");
	const di = argv.indexOf("--dest");
	const dest = di !== -1 && argv[di + 1] ? argv[di + 1] : process.env.CLAUDE_GLOBAL_DIR || join(homedir(), ".claude");
	return { checkOnly, dest: resolve(dest) };
}

/** Lista recursivamente los archivos bajo `dir`, como paths relativos a `dir` (estilo POSIX). Vacío si falta. */
function walk(dir) {
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
function planPairs(dest) {
	const pairs = [];
	const addTree = (srcDir, dstDir) => {
		for (const rel of walk(srcDir)) pairs.push({ src: join(srcDir, rel), dst: join(dstDir, rel) });
	};

	// workflows (plano: *.js + README)
	addTree(join(REPO, ".claude", "workflows"), join(dest, "workflows"));

	// script helper de runtime (archivo único) más su árbol de dependencias lib/ — el CLI importa
	// ./lib/artifact.mjs, etc., así que ambos deben caer juntos para que la copia global resuelva.
	const rtScript = join(REPO, ".claude", "scripts", "build-workflow-artifact.mjs");
	if (existsSync(rtScript)) pairs.push({ src: rtScript, dst: join(dest, "scripts", "build-workflow-artifact.mjs") });
	const rtLib = join(REPO, ".claude", "scripts", "lib");
	if (existsSync(rtLib)) addTree(rtLib, join(dest, "scripts", "lib"));

	// skills del proyecto (recursivo)
	for (const name of PROJECT_SKILLS) addTree(join(REPO, ".claude", "skills", name), join(dest, "skills", name));

	// referencia de primitives, tomada desde el mirror canónico de .pi
	addTree(
		join(SKILLS_ROOT, "ultracode", "reference", "primitives"),
		join(dest, "skills", "ultracode", "reference", "primitives"),
	);

	return pairs;
}

function main() {
	const { checkOnly, dest } = parseArgs(process.argv.slice(2));
	if (checkOnly && reportUnclassifiedSkills("sync-claude-global", classification) > 0) process.exit(1);
	const pairs = planPairs(dest);

	if (pairs.length === 0) {
		console.error("[sync-claude-global] ✗ no source files found — is this the repo root?");
		process.exit(1);
	}

	let drift = 0;
	let wrote = 0;
	for (const { src, dst } of pairs) {
		const want = readFileSync(src);
		const have = existsSync(dst) && statSync(dst).isFile() ? readFileSync(dst) : null;
		const same = have?.equals(want) ?? false;
		if (same) continue;
		if (checkOnly) {
			console.error(`[sync-claude-global] ✗ drift: ${relative(dest, dst)}`);
			drift++;
		} else {
			mkdirSync(dirname(dst), { recursive: true });
			writeFileSync(dst, want);
			wrote++;
		}
	}

	if (checkOnly) {
		if (drift > 0) {
			console.error(
				`[sync-claude-global] ${drift} file(s) out of sync at ${dest} — run: node scripts/sync-claude-global.mjs`,
			);
			process.exit(1);
		}
		console.log(`[sync-claude-global] ✅ in sync at ${dest} (${pairs.length} managed files).`);
	} else {
		console.log(`[sync-claude-global] ✅ synced ${pairs.length} managed files into ${dest} (${wrote} written).`);
	}
}

main();
