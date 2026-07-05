/**
 * Guard: scaffolds carry NO hardcoded model names at call-sites.
 *
 * Why this file exists
 * --------------------
 * The model×effort guidance (L1 system-prompt bullet + L2 ultracode skill) treats
 * model and effort as two independent dials the AUTHORING AGENT decides per task.
 * Scaffolds are the recommendation-by-example layer: if their call-sites hardcode
 * `model: "haiku"`, agents pattern-match the literal pairing instead of deciding.
 *
 * Policy (design spec, run 2026-07-05T11-51-48-660Z-model-effort-guidance):
 *   - Each scaffold that spawns tiered agents declares ONE canonical table:
 *       const TIERS = { cheap: "haiku", balanced: "sonnet", deep: "opus" };
 *     with a comment telling the authoring agent to re-decide tiers per task.
 *   - Call-sites use the symbolic `tier: "cheap"|"balanced"|"deep"` (resolved by
 *     the scaffold's node() helper via TIERS) — never a model name.
 *   - `effort` stays explicit at every call-site (a separate dial; omission would
 *     inherit the raw session reasoning level, since scaffolds set no agentType).
 *
 * Checks per extensions/pandi-dynamic-workflows/scaffolds/*.js:
 *   1. Outside the canonical TIERS line, no `model: "haiku|sonnet|opus"` and no
 *      provider-qualified `model: "<provider>/…"` literal appears.
 *   2. Any file using `tier:` or `TIERS` contains the canonical TIERS line exactly
 *      (byte-identical, so mirrors and docs can quote one form).
 *   3. Every `tier: "<value>"` is one of cheap|balanced|deep — a typo fails HERE,
 *      statically, instead of silently inheriting the orchestrator model at runtime
 *      (node()'s `log("unknown tier …")` is the last-resort net, not the only one).
 *
 * The 5 generated mirrors (.claude/workflows, .pi/skills/ultracode/reference/…,
 * extensions/…/skills/…, .claude/skills/…) are covered transitively by the
 * format:claude / vendor / ultracode parity checks.
 *
 * Run directly:
 *   node extensions/pandi-dynamic-workflows/tests/integration/scaffold-model-literals.test.mjs
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCAFFOLDS_DIR = path.resolve(__dirname, "..", "..", "scaffolds");

const CANONICAL_TIERS = `const TIERS = { cheap: "haiku", balanced: "sonnet", deep: "opus" };`;
const VALID_TIERS = new Set(["cheap", "balanced", "deep"]);
const MODEL_NAME_LITERAL = /model:\s*["'](haiku|sonnet|opus)["']/g;
const MODEL_PROVIDER_LITERAL = /model:\s*["'][\w.-]+\//g;
const TIER_VALUE = /tier:\s*["']([\w-]+)["']/g;

let failures = 0;
function check(name, ok, detail = "") {
	if (ok) {
		console.log(`PASS: ${name}`);
	} else {
		failures += 1;
		console.log(`FAIL: ${name}${detail ? `  [${detail}]` : ""}`);
	}
}

async function main() {
	const files = (await fs.readdir(SCAFFOLDS_DIR)).filter((f) => f.endsWith(".js")).sort();
	check("scaffolds directory has files", files.length > 0, SCAFFOLDS_DIR);

	for (const file of files) {
		const source = await fs.readFile(path.join(SCAFFOLDS_DIR, file), "utf8");
		const withoutTiersLine = source
			.split("\n")
			.filter((line) => !line.includes(CANONICAL_TIERS))
			.join("\n");

		const nameHits = [...withoutTiersLine.matchAll(MODEL_NAME_LITERAL)].map((m) => m[0]);
		check(`${file}: no bare model-name literals outside TIERS`, nameHits.length === 0, nameHits.join(", "));

		const providerHits = [...withoutTiersLine.matchAll(MODEL_PROVIDER_LITERAL)].map((m) => m[0]);
		check(`${file}: no provider-qualified model literals`, providerHits.length === 0, providerHits.join(", "));

		const usesTiers = /\bTIERS\b|tier:\s*["']/.test(withoutTiersLine);
		if (usesTiers) {
			check(`${file}: canonical TIERS line present`, source.includes(CANONICAL_TIERS));
		}

		const badTiers = [...source.matchAll(TIER_VALUE)].map((m) => m[1]).filter((v) => !VALID_TIERS.has(v));
		check(`${file}: all tier values are cheap|balanced|deep`, badTiers.length === 0, badTiers.join(", "));
	}

	console.log(`\nTOTAL: ${failures === 0 ? "all passed" : `${failures} failed`}`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
