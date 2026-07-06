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

const checkOnly = process.argv.includes("--check");

const want = await readMaybe(SRC);
if (want === null) {
	console.error("[sync-agent-guides] ✗ missing source: AGENTS.md");
	process.exit(1);
}
const have = await readMaybe(DST);

if (have === want) {
	console.log("[sync-agent-guides] ✅ CLAUDE.md is in sync with AGENTS.md.");
	process.exit(0);
}

if (checkOnly) {
	console.error(
		"[sync-agent-guides] ✗ drift: CLAUDE.md differs from AGENTS.md — run: node scripts/sync-agent-guides.mjs",
	);
	process.exit(1);
}

await writeFile(DST, want);
console.log("[sync-agent-guides] wrote CLAUDE.md from AGENTS.md.");
