#!/usr/bin/env node
// sync-project-settings.mjs — deriva las entradas `packages` de `.pi/settings*.json`
// desde los manifests de extensión (`extensions/pandi*/package.json`).
//
// Fuente canónica: cada sub-package declara sus recursos Pi (`pi.extensions`, `pi.skills`,
// `pi.themes`). Los settings del repo self-hosted son wiring generado: cargan cada package
// local con paths relativos a `.pi/`. Si un package trae `pi.skills`, el settings usa
// `{ source, skills: [] }` para evitar doble carga: dentro del repo los skills canónicos ya
// se descubren desde `.pi/skills/`, y las copias dentro de extensiones son artifacts vendorizados.
//
// Uso:
//   node scripts/sync-project-settings.mjs           # reescribe `.pi/settings*.json`
//   node scripts/sync-project-settings.mjs --check   # solo verifica; sale 1 si hay drift

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { orderedExtensionDirs } from "./sync-root-manifest.mjs";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SETTINGS_FILES = [join(".pi", "settings.json"), join(".pi", "settings.json.example")];

function readJson(file, fallback = {}) {
	if (!existsSync(file)) return fallback;
	return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
	writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`);
}

function hasEntries(value) {
	return Array.isArray(value) && value.length > 0;
}

function entrySource(entry) {
	return typeof entry === "string" ? entry : entry?.source;
}

function sameJson(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}

function packageDeclaresPiResources(pkg) {
	return hasEntries(pkg.pi?.extensions) || hasEntries(pkg.pi?.skills) || hasEntries(pkg.pi?.themes);
}

function settingsEntryForPackage(repoRoot, dir) {
	const pkg = readJson(join(repoRoot, "extensions", dir, "package.json"));
	const source = `../extensions/${dir}`;
	return hasEntries(pkg.pi?.skills) ? { source, skills: [] } : source;
}

export function deriveProjectSettingsPackages(repoRoot = REPO, loadOrder) {
	const { ordered } = orderedExtensionDirs(repoRoot, loadOrder);
	return ordered
		.filter((dir) => packageDeclaresPiResources(readJson(join(repoRoot, "extensions", dir, "package.json"))))
		.map((dir) => settingsEntryForPackage(repoRoot, dir));
}

function packageDrift(current, wanted) {
	const currentSources = current.map(entrySource).filter(Boolean);
	const wantedSources = wanted.map(entrySource).filter(Boolean);
	const missing = wantedSources.filter((src) => !currentSources.includes(src));
	const stale = currentSources.filter((src) => !wantedSources.includes(src));
	const shape = wanted.filter((want) => {
		const have = current.find((entry) => entrySource(entry) === entrySource(want));
		return have !== undefined && !sameJson(have, want);
	});
	const order = missing.length === 0 && stale.length === 0 && shape.length === 0 && !sameJson(current, wanted);
	return { missing, stale, shape, order };
}

function printDrift(file, current, wanted, error) {
	const drift = packageDrift(current, wanted);
	for (const src of drift.missing) error(`[sync-project-settings] ${file} packages missing: ${src}`);
	for (const src of drift.stale) error(`[sync-project-settings] ${file} packages stale: ${src}`);
	for (const entry of drift.shape) {
		error(`[sync-project-settings] ${file} package shape drift: ${entrySource(entry)}`);
	}
	if (drift.order) error(`[sync-project-settings] ${file} packages order drift.`);
}

export async function syncProjectSettings({
	repoRoot = REPO,
	checkOnly = false,
	loadOrder,
	files = SETTINGS_FILES,
	log = console.log,
	error = console.error,
} = {}) {
	const wanted = deriveProjectSettingsPackages(repoRoot, loadOrder);
	let drift = 0;
	let wrote = 0;

	for (const rel of files) {
		const file = join(repoRoot, rel);
		const settings = readJson(file, { packages: [], extensions: [] });
		const current = Array.isArray(settings.packages) ? settings.packages : [];
		if (sameJson(current, wanted)) continue;
		drift++;
		if (checkOnly) {
			printDrift(rel, current, wanted, error);
			continue;
		}
		settings.packages = wanted;
		if (!Array.isArray(settings.extensions)) settings.extensions = [];
		writeJson(file, settings);
		wrote++;
		log(`[sync-project-settings] wrote ${rel}`);
	}

	if (checkOnly) {
		if (drift > 0) {
			error(
				`[sync-project-settings] ${drift} settings file(s) out of sync — run: node scripts/sync-project-settings.mjs`,
			);
			return { ok: false, drift, wrote, total: files.length };
		}
		log(`[sync-project-settings] ✅ all ${files.length} project settings file(s) in sync.`);
	} else if (wrote === 0) {
		log("[sync-project-settings] already in sync; nothing to write.");
	}
	return { ok: true, drift: 0, wrote, total: files.length };
}

async function main(args = process.argv.slice(2)) {
	const result = await syncProjectSettings({ checkOnly: args.includes("--check") });
	if (!result.ok) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
