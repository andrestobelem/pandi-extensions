/**
 * Durable parity test: the Claude orchestration skills are GENERATED artifacts, not
 * hand-maintained. The canonical SOURCE OF TRUTH is the dual-platform pi skill
 * `.pi/skills/ultracode/` (SKILL.md + reference/). `scripts/generate-claude-ultracode-skills.mjs`
 * emits two Claude skills from it with a MINIMAL transform (only the `name:` frontmatter field
 * and the `# ` H1 heading are renamed; reference/ is copied verbatim):
 *
 *   .pi/skills/ultracode/  ->  .claude/skills/ultracode/         (identity name)
 *                          ->  .claude/skills/dynamic-workflows/ (renamed)
 *
 * This pins:
 *   - In sync: `generate-claude-ultracode-skills.mjs --check` exits 0 (both .claude skills match
 *     what the generator would emit from the canonical .pi source). Fails on any hand-edit.
 *   - The ultracode target is byte-identical to the canonical .pi SKILL.md (identity transform).
 *   - The dynamic-workflows target differs ONLY by the renamed name/heading (minimal transform).
 *   - reference/ is copied verbatim (a canonical sample is byte-identical in both targets).
 *   - Sensitivity (negative control): a one-char tweak to a generated file is detected as drift.
 *
 * No extension build / no model: a pure filesystem + script-process test.
 *
 * Run it:
 *   node extensions/pandi-dynamic-workflows/tests/integration/claude-ultracode-skills-parity.test.mjs
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../shared/test/harness.mjs";
import { withIsolatedRepoCopy, withMutatedFile } from "../../../shared/test/negative-control.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const GEN = path.join(REPO_ROOT, "scripts", "generate-claude-ultracode-skills.mjs");
const PI_SKILL = path.join(REPO_ROOT, ".pi", "skills", "ultracode");
const CLAUDE_SKILLS = path.join(REPO_ROOT, ".claude", "skills");

const { check, counts } = createChecker();

function runCheck(repoRoot = REPO_ROOT) {
	return spawnSync(
		process.execPath,
		[path.join(repoRoot, "scripts", "generate-claude-ultracode-skills.mjs"), "--check"],
		{
			cwd: repoRoot,
			encoding: "utf8",
		},
	);
}

async function main() {
	check("generate-claude-ultracode-skills.mjs exists", fs.existsSync(GEN));

	// 1) Both generated skills are in sync with the canonical .pi source.
	const res = runCheck();
	check(
		"generate-claude-ultracode-skills.mjs --check is in sync",
		res.status === 0,
		`exit=${res.status} ${(res.stderr || res.stdout || "").trim().split("\n").slice(-3).join(" | ")}`,
	);

	const canonical = fs.readFileSync(path.join(PI_SKILL, "SKILL.md"), "utf8");

	// 2) ultracode target = byte-identical to the canonical .pi SKILL.md (identity transform).
	const ultracodeSkill = path.join(CLAUDE_SKILLS, "ultracode", "SKILL.md");
	check(".claude/skills/ultracode/SKILL.md exists", fs.existsSync(ultracodeSkill));
	if (fs.existsSync(ultracodeSkill)) {
		check(
			"ultracode target is byte-identical to the canonical .pi SKILL.md",
			fs.readFileSync(ultracodeSkill, "utf8") === canonical,
		);
	}

	// 3) dynamic-workflows target = canonical with ONLY the name/heading renamed.
	const dwSkill = path.join(CLAUDE_SKILLS, "dynamic-workflows", "SKILL.md");
	check(".claude/skills/dynamic-workflows/SKILL.md exists", fs.existsSync(dwSkill));
	if (fs.existsSync(dwSkill)) {
		const dw = fs.readFileSync(dwSkill, "utf8");
		check("dynamic-workflows target renamed the frontmatter name", /^name: dynamic-workflows$/m.test(dw));
		check("dynamic-workflows target renamed the H1 heading", /^# dynamic-workflows$/m.test(dw));
		// Reverse the minimal transform and confirm nothing else changed.
		const reverted = dw
			.replace(/^name: dynamic-workflows$/m, "name: ultracode")
			.replace(/^# dynamic-workflows$/m, "# ultracode");
		check("dynamic-workflows target differs from canonical ONLY by name/heading", reverted === canonical);
	}

	// 4) reference/ copied verbatim: a canonical sample is byte-identical in both targets.
	const sampleRel = path.join("reference", "primitives", "agent.md");
	const canonSample = path.join(PI_SKILL, sampleRel);
	if (fs.existsSync(canonSample)) {
		const want = fs.readFileSync(canonSample, "utf8");
		for (const name of ["ultracode", "dynamic-workflows"]) {
			const copy = path.join(CLAUDE_SKILLS, name, sampleRel);
			check(
				`${name}/reference/primitives/agent.md is byte-identical to canonical`,
				fs.existsSync(copy) && fs.readFileSync(copy, "utf8") === want,
			);
		}
	}

	// 5) Sensitivity: mutate a generated file in an isolated repo copy and confirm --check catches it.
	await withIsolatedRepoCopy(REPO_ROOT, async (copyRoot) => {
		const copyDwSkill = path.join(copyRoot, ".claude", "skills", "dynamic-workflows", "SKILL.md");
		await withMutatedFile(
			copyDwSkill,
			(orig) => `${orig}\n<!-- drift -->\n`,
			() => {
				check(
					"a one-line tweak to a generated skill is detected as drift (exit 1)",
					runCheck(copyRoot).status === 1,
				);
			},
		);
		check("isolated generated skill restored to in-sync after the negative control", runCheck(copyRoot).status === 0);
	});

	if (counts.failed > 0) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

await main();
