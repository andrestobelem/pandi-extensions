#!/usr/bin/env node
// sync-personas-package.mjs — vendoriza las personas advisor canónicas desde
// .pi/personas/*.json hacia extensions/pandi-personas/personas/*.json para que
// viajen cuando el package se instala standalone.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCE_DIR = join(".pi", "personas");
export const OUT_DIR = join("extensions", "pandi-personas", "personas");

function listJsonFiles(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => entry.name)
		.sort();
}

function readMaybe(file) {
	return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

export function personaPackagePlan(repoRoot = REPO) {
	const sourceDir = join(repoRoot, SOURCE_DIR);
	const outDir = join(repoRoot, OUT_DIR);
	const sourceFiles = listJsonFiles(sourceDir);
	const outFiles = listJsonFiles(outDir);
	const expected = new Map(sourceFiles.map((name) => [name, readFileSync(join(sourceDir, name), "utf8")]));
	const stale = outFiles.filter((name) => !expected.has(name));
	const drift = [];
	for (const [name, content] of expected) {
		const current = readMaybe(join(outDir, name));
		if (current !== content) drift.push(name);
	}
	return { sourceDir, outDir, expected, stale, drift };
}

export function syncPersonasPackage({
	repoRoot = REPO,
	checkOnly = false,
	log = console.log,
	error = console.error,
} = {}) {
	const plan = personaPackagePlan(repoRoot);
	if (checkOnly) {
		for (const name of plan.drift) error(`[sync-personas-package] ✗ drift: ${OUT_DIR}/${name}`);
		for (const name of plan.stale) error(`[sync-personas-package] ✗ stale: ${OUT_DIR}/${name}`);
		if (plan.drift.length || plan.stale.length) {
			error("[sync-personas-package] persona package out of sync — run: node scripts/sync-personas-package.mjs");
			return { ok: false, wrote: 0, drift: plan.drift.length, stale: plan.stale.length };
		}
		log("[sync-personas-package] ✅ packaged personas in sync with .pi/personas.");
		return { ok: true, wrote: 0, drift: 0, stale: 0 };
	}

	mkdirSync(plan.outDir, { recursive: true });
	let wrote = 0;
	for (const [name, content] of plan.expected) {
		const outFile = join(plan.outDir, name);
		if (readMaybe(outFile) !== content) {
			writeFileSync(outFile, content);
			wrote++;
		}
	}
	for (const name of plan.stale) {
		rmSync(join(plan.outDir, name), { force: true });
		wrote++;
	}
	log(`[sync-personas-package] ✅ packaged ${plan.expected.size} persona(s) (${wrote} file change(s)).`);
	return { ok: true, wrote, drift: 0, stale: 0 };
}

function main(args = process.argv.slice(2)) {
	const result = syncPersonasPackage({ checkOnly: args.includes("--check") });
	if (!result.ok) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
