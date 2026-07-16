/**
 * Guard durable para el issue #20.
 *
 * El hook pre-commit versionado debe llegar a los checks baratos de sync/paridad del repo,
 * no solo a typecheck/biome/markdownlint, para detectar drift de mirrors antes de CI.
 *
 * Ejecutalo:
 *   node extensions/pandi-dynamic-workflows/tests/integration/precommit-sync-checks.test.mjs
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { planSyncScripts } from "../../../../../scripts/sync-all.mjs";
import { createChecker } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const PACKAGE_JSON = path.join(REPO_ROOT, "package.json");
const HOOK = path.join(REPO_ROOT, "scripts", "git-hooks", "pre-commit");

const { check, counts } = createChecker();

const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8"));
const hook = fs.readFileSync(HOOK, "utf8");
const syncAllWrite = pkg.scripts?.["sync:all"] ?? "";
const syncAllCheck = pkg.scripts?.["sync:check:all"] ?? "";
const syncGlobalWrite = pkg.scripts?.["sync:all:global"] ?? "";
const testFast = pkg.scripts?.["test:fast"] ?? "";

const repoLocalSyncSteps = [
	"format:claude",
	"sync:manifest",
	"sync:settings",
	"sync:skills",
	"sync:skills:vendor",
	"sync:agents",
	"sync:scaffold-catalog",
	"sync:claude:ultracode",
	"docs:links:check",
	"sync:docs:html",
	"sync:personas",
	"sync:personas:package",
];
const repoLocalCheckSteps = [
	"format:claude:check",
	"sync:manifest:check",
	"sync:settings:check",
	"sync:skills:check",
	"sync:skills:vendor:check",
	"sync:agents:check",
	"sync:scaffold-catalog:check",
	"sync:claude:ultracode:check",
	"docs:links:check",
	"sync:docs:html:check",
	"sync:personas:check",
	"sync:personas:package:check",
];

check("package.json defines sync:all as the sync runner", syncAllWrite === "node scripts/sync-all.mjs");
check(
	"package.json defines sync:check:all as the sync runner check mode",
	syncAllCheck === "node scripts/sync-all.mjs --check",
);
check(
	"package.json defines sync:all:global as the sync runner global mode",
	syncGlobalWrite === "node scripts/sync-all.mjs --global",
);
check(
	"sync runner keeps the repo-local write plan",
	JSON.stringify(planSyncScripts()) === JSON.stringify(repoLocalSyncSteps),
);
check(
	"sync runner keeps the repo-local check plan",
	JSON.stringify(planSyncScripts({ checkOnly: true })) === JSON.stringify(repoLocalCheckSteps),
);
check(
	"sync runner global mode writes global mirror and verifies after writing",
	JSON.stringify(planSyncScripts({ includeGlobal: true })) ===
		JSON.stringify([
			...repoLocalSyncSteps,
			"sync:agents:global:install",
			"sync:claude:global:install",
			...repoLocalCheckSteps,
			"sync:agents:global:check",
			"sync:claude:global:check",
		]),
);
check(
	"pre-commit reaches sync:check:all via the fast gate",
	hook.includes("npm run --silent sync:check:all") ||
		(hook.includes("npm run --silent test:fast") && testFast.includes("npm run sync:check:all")),
	`hook=${JSON.stringify(hook)} test:fast=${JSON.stringify(testFast)}`,
);

if (syncAllCheck) {
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
