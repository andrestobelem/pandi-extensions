#!/usr/bin/env node
/**
 * install-git-hooks.mjs — point git at the versioned hooks dir (scripts/git-hooks).
 *
 * Runs as the `prepare` npm script on every `npm install`. Portable (no shell
 * `||`/`true`, works on Windows) and NEVER fails the install: outside a git
 * checkout (npm tarball, CI cache restore) it is a silent no-op.
 *
 * Logs to STDERR on purpose: `prepare` also runs under `npm pack --json`,
 * whose stdout must stay machine-parseable (packaging-scaffolds suite).
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
