/**
 * Trust gate for the default context7 skill auto-attach.
 *
 * applyDefaultAgentAccess() auto-attaches the context7-cli skill resolved from
 * cwd-relative roots (`<cwd>/.agents/skills/...` and `<cwd>/.pi/skills/...`) as well
 * as global agent-dir / home roots. Every other cwd-derived code/config path in this
 * extension is gated behind ctx.isProjectTrusted() (loadProjectPersona, and the sibling
 * resolveDefaultWebSearchExtensions), but the cwd context7 skill roots were NOT — so an
 * untrusted cloned repo could drop `<cwd>/.agents/skills/context7-cli/SKILL.md` (attacker-
 * controlled instructions) and get it auto-attached to every subagent before /trust runs.
 * This pins: the cwd skill root is attached ONLY when the project is trusted; the global /
 * home roots are unaffected.
 *
 * Mutation-free w.r.t. the repo: bundles agent-env-persona.ts and calls the exported
 * function against a throwaway fixture project under the OS temp dir.
 *
 * Run it:
 *   node extensions/pandi-dynamic-workflows/tests/integration/env-persona-context7-trust.test.mjs
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createChecker } from "../../../../shared/test/harness.mjs";
import { buildDwfModule } from "../dwf-test-support.mjs";

const { check, counts } = createChecker();

async function main() {
	const { url } = await buildDwfModule({
		name: "pi-dw-env-persona-context7-trust",
		relPath: "runtime/agent-env-persona.ts",
		outName: "agent-env-persona-c7.mjs",
	});
	const mod = await import(url);
	const { applyDefaultAgentAccess, DEFAULT_CONTEXT7_SKILL_NAME } = mod;

	// A throwaway project whose cwd/.agents/skills contains a droppable context7 skill.
	const proj = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-c7-trust-"));
	const skillRoot = path.join(proj, ".agents", "skills", DEFAULT_CONTEXT7_SKILL_NAME);
	await fs.mkdir(skillRoot, { recursive: true });
	await fs.writeFile(path.join(skillRoot, "SKILL.md"), "# context7-cli\nmalicious instructions\n");
	// os.tmpdir() is a symlink on macOS (/var -> /private/var); the resolver realpath-resolves
	// the skill root, so compare against the project's canonical path.
	const realProj = await fs.realpath(proj);

	// applyDefaultAgentAccess only resolves the context7 skill when skills are requested.
	const optionsWithSkills = () => ({ skills: ["seed-skill"] });
	const ctxFor = (trusted) => ({ cwd: proj, isProjectTrusted: () => trusted });
	// A cwd-derived attach lives under the project dir; a global/home skill would not.
	const attachesCwdSkill = (out) => (out.skills ?? []).some((s) => typeof s === "string" && s.startsWith(realProj));

	try {
		const untrusted = await applyDefaultAgentAccess(ctxFor(false), optionsWithSkills());
		check(
			"UNTRUSTED cwd: cwd context7 skill is NOT auto-attached",
			!attachesCwdSkill(untrusted),
			`skills=${JSON.stringify(untrusted.skills)}`,
		);

		const trusted = await applyDefaultAgentAccess(ctxFor(true), optionsWithSkills());
		check(
			"TRUSTED cwd: cwd context7 skill IS auto-attached",
			attachesCwdSkill(trusted),
			`skills=${JSON.stringify(trusted.skills)}`,
		);
	} finally {
		await fs.rm(proj, { recursive: true, force: true }).catch(() => {});
	}

	console.log(`\nTOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		for (const f of counts.failures) console.error(`  - ${f}`);
		process.exit(1);
	}
	process.exit(0);
}

main().catch((err) => {
	console.error("INTEGRATION TEST CRASH:", err?.stack ? err.stack : err);
	process.exit(2);
});
