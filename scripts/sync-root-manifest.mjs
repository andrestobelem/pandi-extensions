#!/usr/bin/env node
// sync-root-manifest.mjs — derive the root package.json `pi.extensions` and `pi.themes`
// from each `extensions/pandi-<name>/package.json` pi manifest (SOURCE OF TRUTH = the
// sub-packages). Adding an extension never requires hand-editing the root list; a
// package that declares pi resources but is missing from the root is drift.
//
// Load ORDER is deliberate (it affects e.g. system-prompt append order and status-bar
// slots), so it is curated here: dirs listed in LOAD_ORDER come first in that order;
// any new dir not yet listed is appended alphabetically — it loads without a root
// edit, and can be given a deliberate position later by adding it to LOAD_ORDER.
//
// This mirrors the sync-skill-mirrors pattern (a generator + a --check guarded by a
// parity test): edit a sub-package manifest, then re-run this; the parity test
// (extensions/pandi-dynamic-workflows/tests/integration/root-manifest-parity.test.mjs)
// fails on drift.
//
// Usage:
//   node scripts/sync-root-manifest.mjs           # rewrite the root pi manifest
//   node scripts/sync-root-manifest.mjs --check   # verify only; exit 1 on drift

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_PKG = join(REPO, "package.json");

// Curated load order (dir names). Keep the core first and the UX aliases last.
const LOAD_ORDER = [
	"pandi-dynamic-workflows",
	"pandi-loop",
	"pandi-goal",
	"pandi-plan",
	"pandi-bg",
	"pandi-effort",
	"pandi-mdview",
	"pandi-docs",
	"pandi-local-memory",
	"pandi-auto-compact",
	"pandi-worktree",
	"pandi-container",
	"pandi-typescript-lsp",
	"pandi-rename",
	"pandi-btw",
	"pandi-improve-prompt",
	"pandi",
	"pandi-exit",
	"pandi-clear",
	"pandi-ask",
	"pandi-doctor",
	"pandi-theme",
];

const checkOnly = process.argv.includes("--check");

const isPandiExtensionDir = (d) =>
	(d === "pandi" || d.startsWith("pandi-")) && existsSync(join(REPO, "extensions", d, "package.json"));

const dirs = readdirSync(join(REPO, "extensions")).filter(isPandiExtensionDir).sort();
const known = dirs.filter((d) => LOAD_ORDER.includes(d));
const unknown = dirs.filter((d) => !LOAD_ORDER.includes(d));
const ordered = [...LOAD_ORDER.filter((d) => known.includes(d)), ...unknown];
if (unknown.length) {
	console.warn(
		`[sync-root-manifest] new dirs appended alphabetically (add to LOAD_ORDER to place): ${unknown.join(", ")}`,
	);
}

const derived = { extensions: [], themes: [] };
for (const dir of ordered) {
	const pkg = JSON.parse(readFileSync(join(REPO, "extensions", dir, "package.json"), "utf8"));
	for (const entry of pkg.pi?.extensions ?? []) {
		derived.extensions.push(`./extensions/${dir}/${entry.replace(/^\.\//, "")}`);
	}
	for (const entry of pkg.pi?.themes ?? []) {
		derived.themes.push(`./extensions/${dir}/${entry.replace(/^\.\//, "")}`);
	}
}

const root = JSON.parse(readFileSync(ROOT_PKG, "utf8"));
const current = { extensions: root.pi?.extensions ?? [], themes: root.pi?.themes ?? [] };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const inSync = same(current.extensions, derived.extensions) && same(current.themes, derived.themes);

if (checkOnly) {
	if (inSync) {
		console.log("[sync-root-manifest] root pi manifest in sync with sub-packages.");
		process.exit(0);
	}
	for (const key of ["extensions", "themes"]) {
		const missing = derived[key].filter((e) => !current[key].includes(e));
		const stale = current[key].filter((e) => !derived[key].includes(e));
		if (missing.length) console.error(`[sync-root-manifest] pi.${key} missing: ${missing.join(", ")}`);
		if (stale.length) console.error(`[sync-root-manifest] pi.${key} stale: ${stale.join(", ")}`);
		if (!missing.length && !stale.length && !same(current[key], derived[key])) {
			console.error(`[sync-root-manifest] pi.${key} order drift.`);
		}
	}
	console.error("[sync-root-manifest] drift — run: node scripts/sync-root-manifest.mjs");
	process.exit(1);
}

if (inSync) {
	console.log("[sync-root-manifest] already in sync; nothing to write.");
} else {
	root.pi.extensions = derived.extensions;
	root.pi.themes = derived.themes;
	writeFileSync(ROOT_PKG, `${JSON.stringify(root, null, "\t")}\n`);
	console.log(
		`[sync-root-manifest] wrote root pi manifest (${derived.extensions.length} extensions, ${derived.themes.length} theme paths).`,
	);
}
