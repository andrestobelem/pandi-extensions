/**
 * Durable parity test for MIRRORED skills: a skill that must be available identically in BOTH
 * hosts is stored as the canonical copy under `.pi/skills/<name>/SKILL.md` and mirrored to
 * `.claude/skills/<name>/SKILL.md` by `scripts/sync-skill-mirrors.mjs` (source of truth = .pi).
 *
 * This pins:
 *   - In sync: `sync-skill-mirrors.mjs --check` exits 0 (every mirrored .claude copy byte-equals
 *     its .pi source). Fails if anyone hand-edits one copy without the other.
 *   - Sensitivity (negative control): a one-character tweak to a mirrored copy is detected as
 *     drift (exit 1), so the check is not vacuous. The tweak is reverted afterwards.
 *
 * Host-specific skills (e.g. ultracode, whose catalog paths differ pi vs claude) are intentionally
 * NOT mirrored, so they are not listed by the script and not asserted here.
 *
 * No extension build / no model: a pure filesystem + script-process test.
 *
 * Run it:
 *   node extensions/pandi-dynamic-workflows/tests/integration/skill-mirror-parity.test.mjs
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../shared/test/harness.mjs";
import { withIsolatedRepoCopy, withMutatedFile } from "../../../shared/test/negative-control.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SYNC = path.join(REPO_ROOT, "scripts", "sync-skill-mirrors.mjs");

const { check, counts } = createChecker();

function runCheck(repoRoot = REPO_ROOT) {
	return spawnSync(process.execPath, [path.join(repoRoot, "scripts", "sync-skill-mirrors.mjs"), "--check"], {
		cwd: repoRoot,
		encoding: "utf8",
	});
}

async function main() {
	check("sync-skill-mirrors.mjs exists", fs.existsSync(SYNC));

	// 1) All mirrored skills in sync.
	const res = runCheck();
	check(
		"sync-skill-mirrors.mjs --check is in sync (.claude copies == .pi sources)",
		res.status === 0,
		`exit=${res.status} ${(res.stderr || res.stdout || "").trim().split("\n").slice(-2).join(" | ")}`,
	);

	// The init skill is the concrete mirrored pair we shipped: assert byte-identity directly.
	const piSkill = path.join(REPO_ROOT, ".pi", "skills", "init-pandi-extensions", "SKILL.md");
	const claudeSkill = path.join(REPO_ROOT, ".claude", "skills", "init-pandi-extensions", "SKILL.md");
	check("init skill exists in .pi (source of truth)", fs.existsSync(piSkill));
	check("init skill exists in .claude (mirror)", fs.existsSync(claudeSkill));
	if (fs.existsSync(piSkill) && fs.existsSync(claudeSkill)) {
		const a = fs.readFileSync(piSkill, "utf8");
		const b = fs.readFileSync(claudeSkill, "utf8");
		check(
			"installing skill is byte-identical across hosts",
			a === b && a.length > 100,
			`pi=${a.length} claude=${b.length}`,
		);
	}

	// 2) Sensitivity: mutate a mirror by one char in an isolated repo copy and confirm --check catches it.
	await withIsolatedRepoCopy(REPO_ROOT, async (copyRoot) => {
		const copyClaudeSkill = path.join(copyRoot, ".claude", "skills", "init-pandi-extensions", "SKILL.md");
		await withMutatedFile(
			copyClaudeSkill,
			(orig) => `${orig}\n<!-- drift -->\n`,
			() => {
				const drifted = runCheck(copyRoot);
				check(
					"a one-line tweak to a mirror is detected as drift (exit 1)",
					drifted.status === 1,
					`exit=${drifted.status}`,
				);
			},
		);
		check("isolated mirror restored to in-sync after the negative control", runCheck(copyRoot).status === 0);
	});

	if (counts.failed > 0) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

await main();
