/**
 * Durable guard for issue #20.
 *
 * The versioned pre-commit hook should run the cheap repo sync/parity checks,
 * not only typecheck/biome/markdownlint, so mirror drift is caught before CI.
 *
 * Run it:
 *   node extensions/pandi-dynamic-workflows/tests/integration/precommit-sync-checks.test.mjs
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const PACKAGE_JSON = path.join(REPO_ROOT, "package.json");
const HOOK = path.join(REPO_ROOT, "scripts", "git-hooks", "pre-commit");

const { check, counts } = createChecker();

const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8"));
const hook = fs.readFileSync(HOOK, "utf8");
const syncAll = pkg.scripts?.["sync:check:all"] ?? "";

check("package.json defines sync:check:all", typeof syncAll === "string" && syncAll.length > 0);
for (const required of [
	"format:claude:check",
	"sync:manifest:check",
	"sync:skills:check",
	"sync:skills:vendor:check",
	"sync:agents:check",
	"sync:claude:ultracode:check",
	"docs:links:check",
	"sync:docs:html:check",
	"sync:personas:check",
]) {
	check(`sync:check:all includes ${required}`, syncAll.includes(`npm run -s ${required}`));
}
check("sync:check:all stays repo-local", !syncAll.includes("sync:claude:global:check"));
check("pre-commit runs sync:check:all", hook.includes("npm run --silent sync:check:all"));

if (syncAll) {
	const res = spawnSync("npm", ["run", "-s", "sync:check:all"], { cwd: REPO_ROOT, encoding: "utf8" });
	check(
		"sync:check:all exits 0 in the current tree",
		res.status === 0,
		`exit=${res.status} ${(res.stderr || res.stdout || "").trim().split("\n").slice(-8).join(" | ")}`,
	);
}

if (counts.failed > 0) {
	console.error("\nFailures:");
	for (const failure of counts.failures) console.error(`- ${failure}`);
	process.exit(1);
}
console.log(`\n${counts.passed} checks passed`);
