#!/usr/bin/env node
// sync-claude-global.mjs — mirror this repo's Claude-facing assets into a GLOBAL Claude Code
// home so a global `claude` session has the project's up-to-date workflows, skills, the runtime
// helper script, and the ultracode primitives reference.
//
// SOURCE OF TRUTH = this repo. Destination defaults to ~/.claude and is injectable via
// `--dest <dir>` or `CLAUDE_GLOBAL_DIR` (so tests run against a throwaway tmp dir, never $HOME).
//
// Managed set (repo -> <dest>):
//   - .claude/workflows/*                      -> <dest>/workflows/         (all .js + README)
//   - .claude/scripts/build-workflow-artifact.mjs -> <dest>/scripts/        (Claude runtime helper)
//   - .claude/skills/<PROJECT_SKILLS>/         -> <dest>/skills/<name>/      (recursive)
//   - .pi/skills/ultracode/reference/primitives/* -> <dest>/skills/ultracode/reference/primitives/
//         (canonical primitives docs; each carries **Runtime:** so a Claude reader sees which are
//          pi-only. Sourced from .pi so we never touch the concurrently-edited .claude skill.)
//
// SAFETY: additive only — NO prune. Unmanaged global content (e.g. a global-only skill like
// supacode-cli) is never deleted. `--check` compares without writing and exits 1 on drift.
//
// Usage:
//   node scripts/sync-claude-global.mjs                 # write into ~/.claude
//   node scripts/sync-claude-global.mjs --check         # verify only; exit 1 on drift (no writes)
//   node scripts/sync-claude-global.mjs --dest <dir>    # target an explicit home (tests use this)

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Project-owned Claude skills to publish globally. Global-only skills (e.g. supacode-cli) are NOT
// listed and are left untouched. A skill missing on disk is skipped, not an error — so local-only,
// gitignored skills (e.g. open-prose) are synced best-effort when present and simply absent on CI.
const PROJECT_SKILLS = [
	"ultracode",
	"karpathy-guidelines",
	"modern-software-engineering",
	"installing-pi-dynamic-workflows",
	"open-prose",
];

function parseArgs(argv) {
	const checkOnly = argv.includes("--check");
	const di = argv.indexOf("--dest");
	const dest = di !== -1 && argv[di + 1] ? argv[di + 1] : process.env.CLAUDE_GLOBAL_DIR || join(homedir(), ".claude");
	return { checkOnly, dest: resolve(dest) };
}

/** Recursively list files under `dir`, as paths relative to `dir` (posix-ish). Empty if missing. */
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

/** Build the flat list of {src, dst} absolute file pairs the manifest expands to. */
function planPairs(dest) {
	const pairs = [];
	const addTree = (srcDir, dstDir) => {
		for (const rel of walk(srcDir)) pairs.push({ src: join(srcDir, rel), dst: join(dstDir, rel) });
	};

	// workflows (flat: *.js + README)
	addTree(join(REPO, ".claude", "workflows"), join(dest, "workflows"));

	// runtime helper script (single file)
	const rtScript = join(REPO, ".claude", "scripts", "build-workflow-artifact.mjs");
	if (existsSync(rtScript)) pairs.push({ src: rtScript, dst: join(dest, "scripts", "build-workflow-artifact.mjs") });

	// project skills (recursive)
	for (const name of PROJECT_SKILLS) addTree(join(REPO, ".claude", "skills", name), join(dest, "skills", name));

	// primitives reference, sourced from the canonical .pi mirror
	addTree(
		join(REPO, ".pi", "skills", "ultracode", "reference", "primitives"),
		join(dest, "skills", "ultracode", "reference", "primitives"),
	);

	return pairs;
}

function main() {
	const { checkOnly, dest } = parseArgs(process.argv.slice(2));
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
