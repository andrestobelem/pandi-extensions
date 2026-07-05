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
if (existsSync(path.join(repoRoot, ".git"))) {
	const r = spawnSync("git", ["config", "core.hooksPath", "scripts/git-hooks"], {
		cwd: repoRoot,
		encoding: "utf8",
		timeout: 8000,
	});
	if (r.status === 0) console.error("git hooks: core.hooksPath -> scripts/git-hooks (pre-commit gate active)");
}
process.exit(0);
