#!/usr/bin/env node
/**
 * install-git-hooks.mjs — apunta git al directorio versionado de hooks (scripts/git-hooks).
 *
 * Corre como script `prepare` de npm en cada `npm install`. Es portable (sin shell
 * `||`/`true`, funciona en Windows) y NUNCA hace fallar la instalación: fuera de un
 * checkout de git (npm tarball, restore de caché en CI) es un no-op silencioso.
 *
 * Loguea a STDERR a propósito: `prepare` también corre bajo `npm pack --json`,
 * cuyo stdout debe seguir siendo parseable por máquina (suite packaging-scaffolds).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS_PATH = "scripts/git-hooks";

export function shouldInstallGitHooks(root) {
	return existsSync(path.join(root, ".git"));
}

export function gitHooksConfigArgs(hooksPath = HOOKS_PATH) {
	return ["config", "core.hooksPath", hooksPath];
}

export function installGitHooks(root, spawn = spawnSync) {
	if (!shouldInstallGitHooks(root)) return { skipped: true, status: 0 };
	const r = spawn("git", gitHooksConfigArgs(), {
		cwd: root,
		encoding: "utf8",
		timeout: 8000,
	});
	return { skipped: false, status: r.status };
}

function main() {
	const r = installGitHooks(repoRoot);
	if (!r.skipped && r.status === 0)
		console.error("git hooks: core.hooksPath -> scripts/git-hooks (pre-commit + commit-msg gates active)");
	process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
