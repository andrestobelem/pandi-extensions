/**
 * run-report-tokens — parity pin: the pandi token CSS inlined in observe/html.ts
 * (per-extension duplication is intentional; no cross-boundary import is allowed)
 * must stay semantically identical to the canonical
 * .pi/skills/pandi-artifact-style/reference/pandi-tokens.css: same custom-property
 * set with the same values, in both the dark root block and the light
 * prefers-color-scheme override. Formatting/comments may differ; values may not.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createChecker, buildExtension as sharedBuildExtension } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const CANONICAL = path.join(REPO_ROOT, ".pi", "skills", "pandi-artifact-style", "reference", "pandi-tokens.css");

const { check, counts } = createChecker();

/** Parse `--name: value;` pairs into { dark: {...}, light: {...} } by media block. */
function parseTokens(css) {
	const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const lightStart = noComments.indexOf("@media");
	const dark = lightStart === -1 ? noComments : noComments.slice(0, lightStart);
	const light = lightStart === -1 ? "" : noComments.slice(lightStart);
	const grab = (block) => {
		const out = {};
		for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[m[1]] = m[2].trim();
		return out;
	};
	return { dark: grab(dark), light: grab(light) };
}

function diffTokens(label, a, b) {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	const diffs = [];
	for (const k of keys) if (a[k] !== b[k]) diffs.push(`${k}: canonical=${a[k] ?? "∅"} inlined=${b[k] ?? "∅"}`);
	check(`${label} tokens match canonical`, diffs.length === 0, diffs.slice(0, 5).join("; "));
}

async function main() {
	const { url } = await sharedBuildExtension({
		name: "pi-run-report-tokens",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "observe/html.ts"),
		outName: "run-report-html.mjs",
	});
	const mod = await import(url);
	check("PANDI_TOKENS_CSS exported", typeof mod.PANDI_TOKENS_CSS === "string");

	const canonical = parseTokens(await fs.readFile(CANONICAL, "utf8"));
	const inlined = parseTokens(mod.PANDI_TOKENS_CSS);
	check("canonical file parsed non-empty", Object.keys(canonical.dark).length > 0);
	diffTokens("dark", canonical.dark, inlined.dark);
	diffTokens("light", canonical.light, inlined.light);
	check(
		"light override is prefers-color-scheme gated",
		/@media\s*\(prefers-color-scheme:\s*light\)/.test(mod.PANDI_TOKENS_CSS),
	);

	if (counts.failed > 0) {
		console.error(`\n${counts.failed} checks FAILED:`);
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
