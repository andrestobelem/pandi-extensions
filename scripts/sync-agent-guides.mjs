#!/usr/bin/env node
// sync-agent-guides.mjs — mirror the root agent guide byte-identically from the canonical
// `AGENTS.md` (SOURCE OF TRUTH, the cross-agent standard Pi reads) to `CLAUDE.md` (the copy
// Claude Code reads), so the two cannot drift.
//
// Same shape as sync-skill-mirrors.mjs (a writer + a --check guarded by a parity test): edit
// AGENTS.md, then re-run this; the parity test
// (extensions/pandi-dynamic-workflows/tests/integration/agent-guide-mirror-parity.test.mjs)
// fails on drift.
//
// Usage:
//   node scripts/sync-agent-guides.mjs           # write CLAUDE.md from AGENTS.md
//   node scripts/sync-agent-guides.mjs --check    # verify only; exit 1 on drift (no writes)

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO, "AGENTS.md");
const DST = join(REPO, "CLAUDE.md");

const checkOnly = process.argv.includes("--check");

async function readMaybe(file) {
	try {
		return await readFile(file, "utf8");
	} catch {
		return null;
	}
}

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
