#!/usr/bin/env node
/**
 * workflow-preview-smoke — deferred pin from the run-report design record (§6.6).
 *
 * The pre-launch preview helper should keep rendering a real scaffold into a
 * self-contained HTML artifact. This is a cheap regression smoke for the
 * "preview keeps working" criterion, plus the Pandi artifact-style skin used by
 * the newer docs/report pages.
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
const BUILDERS = [
	{
		label: "claude modular builder",
		path: path.join(REPO_ROOT, ".claude", "scripts", "build-workflow-artifact.mjs"),
	},
	{
		label: "pi compatibility builder",
		path: path.join(REPO_ROOT, ".pi", "scripts", "build-workflow-artifact.mjs"),
	},
];
const SCAFFOLD = path.join(
	REPO_ROOT,
	"extensions",
	"pandi-dynamic-workflows",
	"scaffolds",
	"fan-out-and-synthesize.js",
);
const CLAUDE_TOKENS = path.join(REPO_ROOT, ".claude", "scripts", "lib", "pandi-tokens.css");
const CANONICAL_TOKENS = path.join(REPO_ROOT, ".pi", "skills", "pandi-artifact-style", "reference", "pandi-tokens.css");

const { check, counts } = createChecker();

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "workflow-preview-smoke-"));
const args = JSON.stringify({ task: "preview smoke", items: ["one", "two"] });

check("fan-out-and-synthesize scaffold exists", fs.existsSync(SCAFFOLD));
check("workflow preview tokens are present", fs.existsSync(CLAUDE_TOKENS));
if (fs.existsSync(CLAUDE_TOKENS) && fs.existsSync(CANONICAL_TOKENS)) {
	check(
		"workflow preview tokens match canonical pandi artifact tokens",
		fs.readFileSync(CLAUDE_TOKENS, "utf8") === fs.readFileSync(CANONICAL_TOKENS, "utf8"),
	);
}

for (const builder of BUILDERS) {
	const out = path.join(tmp, `${builder.label.replace(/\W+/g, "-")}.html`);
	check(`${builder.label} exists`, fs.existsSync(builder.path));
	const res = spawnSync(process.execPath, [builder.path, SCAFFOLD, out, args], { cwd: REPO_ROOT, encoding: "utf8" });
	check(
		`${builder.label} exits 0`,
		res.status === 0,
		`exit=${res.status} ${(res.stderr || res.stdout || "").trim().split("\n").slice(-8).join(" | ")}`,
	);
	check(`${builder.label} artifact was written`, fs.existsSync(out));
	const html = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
	check(`${builder.label} artifact is HTML`, /<html[\s>]/i.test(html) && /<\/html>/i.test(html));
	check(`${builder.label} names the scaffold`, html.includes("fan-out-and-synthesize"));
	check(`${builder.label} includes agent prompt content`, /agent|prompt/i.test(html));
	check(`${builder.label} embeds pandi dark accent token`, /--accent:\s*#FF75B5/.test(html));
	check(`${builder.label} embeds pandi light color-scheme override`, /prefers-color-scheme:\s*light/.test(html));
	check(`${builder.label} uses mermaid base theme`, /theme:\s*"base"/.test(html));
	check(`${builder.label} wires mermaid theme variables`, /themeVariables/.test(html));
	check(`${builder.label} no longer uses the legacy neutral mermaid theme`, !/theme:\s*"neutral"/.test(html));
	check(`${builder.label} uses pandi themed highlight.js CSS`, /\.hljs-keyword[^}]*var\(--accent\)/.test(html));
	check(`${builder.label} uses auto themed code comments`, /\.hljs-comment[^}]*var\(--line-strong\)/.test(html));
	check(`${builder.label} does not force atom-one-light for Full script`, !/atom-one-light/.test(html));
}

await fsp.rm(tmp, { recursive: true, force: true });

if (counts.failed > 0) {
	console.error("\nFailures:");
	for (const failure of counts.failures) console.error(`- ${failure}`);
	process.exit(1);
}
console.log(`\n${counts.passed} checks passed`);
