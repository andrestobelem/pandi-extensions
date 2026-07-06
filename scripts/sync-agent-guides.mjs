#!/usr/bin/env node
// sync-agent-guides.mjs — espeja byte a byte la guía raíz de agentes desde el canónico
// `AGENTS.md` (fuente de verdad, el estándar cross-agent que lee Pi) hacia `CLAUDE.md` (la copia
// que lee Claude Code), para que no puedan divergir.
//
// Tiene la misma forma que sync-skill-mirrors.mjs (un writer + un --check protegido por un test de parity):
// editá AGENTS.md y luego re-ejecutá esto; el test de parity
// (extensions/pandi-dynamic-workflows/tests/integration/agent-guide-mirror-parity.test.mjs)
// falla si hay drift.
//
// Uso:
//   node scripts/sync-agent-guides.mjs           # escribe CLAUDE.md desde AGENTS.md
//   node scripts/sync-agent-guides.mjs --check    # solo verifica; sale con 1 si hay drift (sin writes)

import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readMaybe } from "./lib/sync-file-tree.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO, "AGENTS.md");
const DST = join(REPO, "CLAUDE.md");

export function parseCheckOnly(args = process.argv.slice(2)) {
	return args.includes("--check");
}

export function guideMirrorPair(repo = REPO) {
	return { src: join(repo, "AGENTS.md"), dst: join(repo, "CLAUDE.md") };
}

export async function syncAgentGuides({
	checkOnly = false,
	src = SRC,
	dst = DST,
	log = console.log,
	error = console.error,
} = {}) {
	const want = await readMaybe(src);
	if (want === null) {
		error("[sync-agent-guides] ✗ missing source: AGENTS.md");
		return { ok: false, wrote: false, drift: false, missing: true };
	}
	const have = await readMaybe(dst);

	if (have === want) {
		log("[sync-agent-guides] ✅ CLAUDE.md is in sync with AGENTS.md.");
		return { ok: true, wrote: false, drift: false, missing: false };
	}

	if (checkOnly) {
		error("[sync-agent-guides] ✗ drift: CLAUDE.md differs from AGENTS.md — run: node scripts/sync-agent-guides.mjs");
		return { ok: false, wrote: false, drift: true, missing: false };
	}

	await writeFile(dst, want);
	log("[sync-agent-guides] wrote CLAUDE.md from AGENTS.md.");
	return { ok: true, wrote: true, drift: false, missing: false };
}

async function main(args = process.argv.slice(2)) {
	const result = await syncAgentGuides({ checkOnly: parseCheckOnly(args) });
	if (!result.ok) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
