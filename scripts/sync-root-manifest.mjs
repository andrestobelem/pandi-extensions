#!/usr/bin/env node
// sync-root-manifest.mjs — deriva `pi.extensions` y `pi.themes` del package.json raíz
// desde cada manifiesto pi `extensions/pandi-<name>/package.json` (fuente de verdad = los
// sub-packages). Agregar una extensión nunca requiere editar a mano la lista raíz; un
// package que declara recursos pi pero falta en la raíz es drift.
//
// El ORDER de carga es deliberado (afecta, por ejemplo, el orden de append del system-prompt
// y los slots de la status-bar), por eso se cura acá: los dirs listados en LOAD_ORDER van primero
// en ese orden; cualquier dir nuevo que aún no esté listado se agrega al final alfabéticamente —
// carga sin editar la raíz y más tarde puede recibir una posición deliberada agregándolo a LOAD_ORDER.
//
// Esto sigue el patrón de sync-skill-mirrors (un generator + un --check protegido por un
// test de parity): editá el manifiesto del sub-package y luego re-ejecutá esto; el test de parity
// (extensions/pandi-dynamic-workflows/tests/integration/root-manifest-parity.test.mjs)
// falla si hay drift.
//
// Uso:
//   node scripts/sync-root-manifest.mjs           # reescribe el manifiesto pi raíz
//   node scripts/sync-root-manifest.mjs --check   # solo verifica; sale con 1 si hay drift

import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCheckOnly } from "./lib/cli-args.mjs";
import { readJsonFile, writeJsonFile } from "./lib/json-io.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_PKG = join(REPO, "package.json");

// Pi requiere que los paquetes Pi transitivos se expongan desde node_modules del bundle.
export const BUNDLED_EXTENSION_ENTRIES = [
	"./node_modules/pi-codex-web-search/src/index.ts",
	"./node_modules/pi-mcp-adapter/index.ts",
	"./node_modules/pi-cursor-sdk/src/index.ts",
];

// Orden de carga curado (nombres de dir). Mantené el core primero y los aliases de UX al final.
const LOAD_ORDER = [
	"pandi-dynamic-workflows",
	// Hosts autónomos: no declaran recursos `pi`, pero se registran para que el sync no los marque como paquetes desconocidos.
	"pandi-ultracode-cursor",
	"pandi-ultracode-claude",
	"pandi-ultracode-codex",
	"pandi-personas",
	"pandi-session",
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
	"pandi-kitty",
	"pandi-container",
	"pandi-podman",
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

function isPandiExtensionDir(repoRoot, dir) {
	return (
		(dir === "pandi" || dir.startsWith("pandi-")) && existsSync(join(repoRoot, "extensions", dir, "package.json"))
	);
}

export function orderedExtensionDirs(repoRoot, loadOrder = LOAD_ORDER) {
	const dirs = readdirSync(join(repoRoot, "extensions"))
		.filter((dir) => isPandiExtensionDir(repoRoot, dir))
		.sort();
	const known = dirs.filter((dir) => loadOrder.includes(dir));
	const unknown = dirs.filter((dir) => !loadOrder.includes(dir));
	return { ordered: [...loadOrder.filter((dir) => known.includes(dir)), ...unknown], unknown };
}

export function deriveRootManifest(repoRoot, loadOrder = LOAD_ORDER) {
	const { ordered, unknown } = orderedExtensionDirs(repoRoot, loadOrder);
	const derived = { extensions: [], themes: [] };
	for (const dir of ordered) {
		const pkg = readJsonFile(join(repoRoot, "extensions", dir, "package.json"));
		for (const entry of pkg.pi?.extensions ?? []) {
			derived.extensions.push(`./extensions/${dir}/${entry.replace(/^\.\//, "")}`);
		}
		for (const entry of pkg.pi?.themes ?? []) {
			derived.themes.push(`./extensions/${dir}/${entry.replace(/^\.\//, "")}`);
		}
	}
	derived.extensions.push(...BUNDLED_EXTENSION_ENTRIES);
	return { derived, unknown };
}

export function sameList(a, b) {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

function printDrift(current, derived) {
	for (const key of ["extensions", "themes"]) {
		const missing = derived[key].filter((e) => !current[key].includes(e));
		const stale = current[key].filter((e) => !derived[key].includes(e));
		if (missing.length) console.error(`[sync-root-manifest] pi.${key} missing: ${missing.join(", ")}`);
		if (stale.length) console.error(`[sync-root-manifest] pi.${key} stale: ${stale.join(", ")}`);
		if (!missing.length && !stale.length && !sameList(current[key], derived[key])) {
			console.error(`[sync-root-manifest] pi.${key} order drift.`);
		}
	}
}

function main() {
	const checkOnly = parseCheckOnly(process.argv.slice(2));
	const { derived, unknown } = deriveRootManifest(REPO);
	if (unknown.length) {
		console.warn(
			`[sync-root-manifest] new dirs appended alphabetically (add to LOAD_ORDER to place): ${unknown.join(", ")}`,
		);
	}

	const root = readJsonFile(ROOT_PKG);
	const current = { extensions: root.pi?.extensions ?? [], themes: root.pi?.themes ?? [] };
	const inSync = sameList(current.extensions, derived.extensions) && sameList(current.themes, derived.themes);

	if (checkOnly) {
		if (inSync) {
			console.log("[sync-root-manifest] root pi manifest in sync with sub-packages.");
			process.exit(0);
		}
		printDrift(current, derived);
		console.error("[sync-root-manifest] drift — run: node scripts/sync-root-manifest.mjs");
		process.exit(1);
	}

	if (inSync) {
		console.log("[sync-root-manifest] already in sync; nothing to write.");
	} else {
		root.pi.extensions = derived.extensions;
		root.pi.themes = derived.themes;
		writeJsonFile(ROOT_PKG, root);
		console.log(
			`[sync-root-manifest] wrote root pi manifest (${derived.extensions.length} extensions, ${derived.themes.length} theme paths).`,
		);
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
