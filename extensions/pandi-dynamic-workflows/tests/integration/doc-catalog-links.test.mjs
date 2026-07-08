/**
 * Guard durable de documentación para issue #19.
 *
 * El catálogo/count del README y los links relativos locales deben fallar rápido en `npm test`,
 * no durante onboarding. El script reutilizable es intencionalmente read-only y
 * lo bastante barato para correr como suite de integración.
 *
 * Corrida:
 *   node extensions/pandi-dynamic-workflows/tests/integration/doc-catalog-links.test.mjs
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "check-doc-catalog-and-links.mjs");

const { check, counts } = createChecker();

const res = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });

check("check-doc-catalog-and-links.mjs exists", fs.existsSync(SCRIPT));
check(
	"README catalog and local relative docs links are in sync",
	res.status === 0,
	`exit=${res.status} ${(res.stderr || res.stdout || "").trim().split("\n").slice(0, 12).join(" | ")}`,
);

if (counts.failed > 0) {
	console.error("\nFailures:");
	for (const failure of counts.failures) console.error(`- ${failure}`);
	process.exit(1);
}
console.log(`\n${counts.passed} checks passed`);
