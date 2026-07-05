#!/usr/bin/env node
/**
 * workflow-preview-smoke — deferred pin from the run-report design record (§6.6).
 *
 * The pre-launch preview helper should keep rendering a real scaffold into a
 * self-contained HTML artifact. This is a cheap regression smoke for the
 * "preview keeps working" criterion.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const BUILDER = path.join(REPO_ROOT, ".pi", "scripts", "build-workflow-artifact.mjs");
const SCAFFOLD = path.join(
	REPO_ROOT,
	"extensions",
	"pandi-dynamic-workflows",
	"scaffolds",
	"fan-out-and-synthesize.js",
);

const { check, counts } = createChecker();

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "workflow-preview-smoke-"));
const out = path.join(tmp, "preview.html");
const args = JSON.stringify({ task: "preview smoke", items: ["one", "two"] });

check("build-workflow-artifact.mjs exists", fs.existsSync(BUILDER));
check("fan-out-and-synthesize scaffold exists", fs.existsSync(SCAFFOLD));
const res = spawnSync("node", [BUILDER, SCAFFOLD, out, args], { cwd: REPO_ROOT, encoding: "utf8" });
check(
	"preview builder exits 0",
	res.status === 0,
	`exit=${res.status} ${(res.stderr || res.stdout || "").trim().split("\n").slice(-8).join(" | ")}`,
);
check("preview artifact was written", fs.existsSync(out));
const html = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
check("preview artifact is HTML", /<html[\s>]/i.test(html) && /<\/html>/i.test(html));
check("preview names the scaffold", html.includes("fan-out-and-synthesize"));
check("preview includes agent prompt content", /agent|prompt/i.test(html));

await fsp.rm(tmp, { recursive: true, force: true });

if (counts.failed > 0) {
	console.error("\nFailures:");
	for (const failure of counts.failures) console.error(`- ${failure}`);
	process.exit(1);
}
console.log(`\n${counts.passed} checks passed`);
