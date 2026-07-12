#!/usr/bin/env node
// Runner canónico para syncs agregados del repo. Mantiene la lista de pasos en
// un solo lugar y deja `package.json` como alias de UX.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCheckOnly } from "./lib/cli-args.mjs";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const REPO_LOCAL_SYNC_STEPS = [
	{ write: "format:claude", check: "format:claude:check" },
	{ write: "sync:manifest", check: "sync:manifest:check" },
	{ write: "sync:settings", check: "sync:settings:check" },
	{ write: "sync:skills", check: "sync:skills:check" },
	{ write: "sync:skills:vendor", check: "sync:skills:vendor:check" },
	{ write: "sync:agents", check: "sync:agents:check" },
	{ write: "sync:scaffold-catalog", check: "sync:scaffold-catalog:check" },
	{ write: "sync:claude:ultracode", check: "sync:claude:ultracode:check" },
	{ write: "docs:links:check", check: "docs:links:check" },
	{ write: "sync:docs:html", check: "sync:docs:html:check" },
	{ write: "sync:personas", check: "sync:personas:check" },
	{ write: "sync:personas:package", check: "sync:personas:package:check" },
];

function repoLocalScripts(checkOnly) {
	return REPO_LOCAL_SYNC_STEPS.map((step) => (checkOnly ? step.check : step.write));
}

export function planSyncScripts({ checkOnly = false, includeGlobal = false } = {}) {
	if (checkOnly) {
		return includeGlobal ? [...repoLocalScripts(true), "sync:claude:global:check"] : repoLocalScripts(true);
	}

	if (includeGlobal) {
		return [...repoLocalScripts(false), "sync:claude:global", ...repoLocalScripts(true), "sync:claude:global:check"];
	}

	return repoLocalScripts(false);
}

export function runSyncScripts(scripts, { cwd = REPO, spawn = spawnSync } = {}) {
	for (const script of scripts) {
		const result = spawn("npm", ["run", "-s", script], { cwd, stdio: "inherit" });
		const status = result.status ?? 1;
		if (status !== 0) return { ok: false, failedScript: script, status };
	}
	return { ok: true, status: 0 };
}

export function parseArgs(args = process.argv.slice(2)) {
	return {
		checkOnly: parseCheckOnly(args),
		includeGlobal: args.includes("--global"),
	};
}

function main(args = process.argv.slice(2)) {
	const plan = planSyncScripts(parseArgs(args));
	const result = runSyncScripts(plan);
	if (!result.ok) {
		console.error(`[sync-all] failed at ${result.failedScript}`);
		process.exit(result.status);
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
