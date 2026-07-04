/**
 * Behavioral contract test: the tier DECISION (cheap vs strong model + effort per node)
 * is made correctly wherever workflows are CREATED, not just where they run (#25).
 *
 * Finding: workflow-factory — the path that generates NEW workflows — never decided
 * tiers: the planner's PLAN schema had no per-node budget field, the codegen contract
 * listed `{ label, schema, phase, effort }` (omitting `model`) with no tiering
 * requirement, and the reviewer checked generic "cost" with no explicit tier item.
 * Generated workflows therefore inherited the session model on every node (scouts at
 * opus prices, silently).
 *
 * This pins:
 *  1. FACTORY PLAN: the PLAN schema requires `budget` entries of
 *     { role, model, effort, why }, and the planner prompt carries the same normative
 *     ladder policy as contract-gate (single policy text in the repo).
 *  2. FACTORY CODEGEN: the call-contract line includes `model`, and a hard requirement
 *     demands explicit per-node model+effort from the plan's budget with the
 *     node(role)/input.models/input.efforts override convention.
 *  3. FACTORY REVIEW: the reviewer checklist has an explicit TIERING item (wide fan-out
 *     on the deep tier / judge-synthesis on the cheap tier / nodes missing explicit
 *     model+effort are findings).
 *  4. CATALOG INVARIANT: in EVERY scaffold, each call-site that sets `model` on agent
 *     options also sets `effort` nearby, and both come from the known ladder
 *     (haiku|sonnet|opus x low|medium|high|xhigh|max) — pinning the audited tiering
 *     of the catalog so an untiered or inverted node cannot silently land.
 *
 * Mutation-free: reads the scaffold sources and pattern-matches.
 *
 * Run it:
 *   node extensions/pi-dynamic-workflows/tests/integration/scaffold-model-tiering.test.mjs
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createChecker, REPO_ROOT } from "../../../shared/test/harness.mjs";

const { check, counts } = createChecker();

const SCAFFOLDS_DIR = path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "scaffolds");
const factorySrc = fs.readFileSync(path.join(SCAFFOLDS_DIR, "workflow-factory.js"), "utf8");
const gateSrc = fs.readFileSync(path.join(SCAFFOLDS_DIR, "contract-gate.js"), "utf8");

// The normative ladder policy: both fragments must appear wherever the tier decision
// is delegated to a model (contract-gate's resource-plan AND the factory's planner).
const LADDER = "haiku < sonnet < opus";
const KEEP_CHEAP = "cheap even at premium";

// ---------------------------------------------------------------------------
// 1) FACTORY PLAN: budget field + ladder policy in the planner prompt.
// ---------------------------------------------------------------------------

// The PLAN schema (the required array that also lists promptContracts) includes budget.
const planRequired = factorySrc.match(/required:\s*\[[^\]]*"promptContracts"[^\]]*\]/s)?.[0] ?? "";
check(
	'factory plan: PLAN schema requires "budget"',
	planRequired.includes('"budget"'),
	planRequired || "PLAN required array not found",
);
check(
	"factory plan: budget entries require role/model/effort/why",
	/required:\s*\[\s*"role",\s*"model",\s*"effort",\s*"why"\s*\]/.test(factorySrc),
	"no budget item schema with required [role, model, effort, why]",
);
check(
	`factory plan: planner prompt carries the ladder policy ("${LADDER}")`,
	factorySrc.includes(LADDER),
	"ladder sentence missing from workflow-factory",
);
check(
	`factory plan: planner prompt keeps mechanical roles cheap ("${KEEP_CHEAP}")`,
	factorySrc.includes(KEEP_CHEAP),
	"keep-cheap-even-at-premium sentence missing from workflow-factory",
);
check(
	"policy single-source: contract-gate carries the same ladder sentence",
	gateSrc.includes(LADDER) && gateSrc.includes(KEEP_CHEAP),
	"contract-gate lost the normative ladder policy",
);

// ---------------------------------------------------------------------------
// 2) FACTORY CODEGEN: call contract includes model; tiering is a hard requirement.
// ---------------------------------------------------------------------------

check(
	"factory codegen: call contract includes model ({ label, model, effort, schema, phase })",
	factorySrc.includes("{ label, model, effort, schema, phase }"),
	"codegen call-contract line does not offer the model option",
);
check(
	"factory codegen: TIER EVERY NODE hard requirement present",
	factorySrc.includes("TIER EVERY NODE"),
	"codegen has no explicit per-node tiering requirement",
);
check(
	"factory codegen: the tiering requirement itself demands the input.models[role] override convention",
	// Anchored to the SAME bullet line as TIER EVERY NODE, so the factory's own node()
	// helper comment (which also mentions input.models[role]) cannot vacuously satisfy it.
	/TIER EVERY NODE[^\n]*input\.models\[role\]/.test(factorySrc),
	"codegen does not require the per-role override convention in the tiering bullet",
);

// ---------------------------------------------------------------------------
// 3) FACTORY REVIEW: explicit tier-check item in the reviewer checklist.
// ---------------------------------------------------------------------------

check(
	"factory review: reviewer checklist has the TIERING item",
	factorySrc.includes("Also check TIERING"),
	"review prompt has no explicit tier-check item",
);

// ---------------------------------------------------------------------------
// 4) CATALOG INVARIANT: every model call-site is paired with a ladder effort.
// ---------------------------------------------------------------------------

const MODELS = new Set(["haiku", "sonnet", "opus"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
// Only string-literal model options match (schema property definitions use `model: {`).
const MODEL_SITE = /model:\s*"([^"]+)"/g;
const EFFORT_SITE = /effort:\s*"([^"]+)"/;
const WINDOW_LINES = 5;

const scaffolds = fs
	.readdirSync(SCAFFOLDS_DIR)
	.filter((f) => f.endsWith(".js"))
	.sort();
check("catalog: scaffolds discovered", scaffolds.length >= 20, `found ${scaffolds.length}`);

for (const file of scaffolds) {
	const src = fs.readFileSync(path.join(SCAFFOLDS_DIR, file), "utf8");
	const lines = src.split("\n");
	const problems = [];
	for (let i = 0; i < lines.length; i++) {
		MODEL_SITE.lastIndex = 0;
		for (const m of lines[i].matchAll(MODEL_SITE)) {
			const model = m[1];
			if (!MODELS.has(model)) {
				problems.push(`${file}:${i + 1} model "${model}" is not on the ladder (haiku|sonnet|opus)`);
				continue;
			}
			// The paired effort must sit in the same options literal; scaffold style keeps
			// them within a few lines (same line or adjacent lines of the object literal).
			const lo = Math.max(0, i - WINDOW_LINES);
			const hi = Math.min(lines.length, i + WINDOW_LINES + 1);
			const windowText = lines.slice(lo, hi).join("\n");
			const effort = windowText.match(EFFORT_SITE)?.[1];
			if (!effort) {
				problems.push(`${file}:${i + 1} model "${model}" has no effort within ±${WINDOW_LINES} lines`);
			} else if (!EFFORTS.has(effort)) {
				problems.push(`${file}:${i + 1} effort "${effort}" is not on the ladder (low..max)`);
			}
		}
	}
	check(`catalog: ${file} pairs every model with a ladder effort`, problems.length === 0, problems.join("; "));
}

console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
if (counts.failed) {
	console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
	process.exit(1);
}
