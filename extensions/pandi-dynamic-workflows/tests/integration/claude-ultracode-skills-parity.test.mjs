/**
 * Test durable de paridad: los skills de orquestación Claude son artifacts GENERADOS, no
 * mantenidos a mano. La SOURCE OF TRUTH canónica es el skill pi dual-platform
 * `.pi/skills/ultracode/` (SKILL.md + reference/). `scripts/generate-claude-ultracode-skills.mjs`
 * emite dos skills Claude desde ahí con una transform MINIMAL (solo se renombran el campo
 * frontmatter `name:` y el heading H1 `# `; reference/ se copia verbatim):
 *
 *   .pi/skills/ultracode/  ->  .claude/skills/ultracode/         (nombre identity)
 *                          ->  .claude/skills/dynamic-workflows/ (renombrado)
 *
 * Esto pinea:
 *   - En sync: `generate-claude-ultracode-skills.mjs --check` sale 0 (ambos skills .claude
 *     coinciden con lo que el generador emitiría desde la fuente .pi canónica). Falla ante hand-edit.
 *   - El target ultracode es byte-identical al SKILL.md .pi canónico (identity transform).
 *   - El target dynamic-workflows difiere SOLO por name/heading renombrados (minimal transform).
 *   - reference/ se copia verbatim (una muestra canónica es byte-identical en ambos targets).
 *   - Sensibilidad (negative control): un tweak de un char en un archivo generado se detecta como drift.
 *
 * Sin build de extensión / sin modelo: test puro de filesystem + script-process.
 *
 * Corrida:
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

	// 1) Ambos skills generados están en sync con la fuente .pi canónica.
	const res = runCheck();
	check(
		"generate-claude-ultracode-skills.mjs --check is in sync",
		res.status === 0,
		`exit=${res.status} ${(res.stderr || res.stdout || "").trim().split("\n").slice(-3).join(" | ")}`,
	);

	const canonical = fs.readFileSync(path.join(PI_SKILL, "SKILL.md"), "utf8");

	// 2) target ultracode = byte-identical al SKILL.md .pi canónico (identity transform).
	const ultracodeSkill = path.join(CLAUDE_SKILLS, "ultracode", "SKILL.md");
	check(".claude/skills/ultracode/SKILL.md exists", fs.existsSync(ultracodeSkill));
	if (fs.existsSync(ultracodeSkill)) {
		check(
			"ultracode target is byte-identical to the canonical .pi SKILL.md",
			fs.readFileSync(ultracodeSkill, "utf8") === canonical,
		);
	}

	// 3) target dynamic-workflows = canónico con SOLO name/heading renombrados.
	const dwSkill = path.join(CLAUDE_SKILLS, "dynamic-workflows", "SKILL.md");
	check(".claude/skills/dynamic-workflows/SKILL.md exists", fs.existsSync(dwSkill));
	if (fs.existsSync(dwSkill)) {
		const dw = fs.readFileSync(dwSkill, "utf8");
		check("dynamic-workflows target renamed the frontmatter name", /^name: dynamic-workflows$/m.test(dw));
		check("dynamic-workflows target renamed the H1 heading", /^# dynamic-workflows$/m.test(dw));
		// Revertí la transform minimal y confirmá que nada más cambió.
		const reverted = dw
			.replace(/^name: dynamic-workflows$/m, "name: ultracode")
			.replace(/^# dynamic-workflows$/m, "# ultracode");
		check("dynamic-workflows target differs from canonical ONLY by name/heading", reverted === canonical);
	}

	// 4) reference/ copiado verbatim: una muestra canónica es byte-identical en ambos targets.
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

	// 5) Sensibilidad: mutá un archivo generado en una copia aislada del repo y confirmá que --check lo captura.
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
