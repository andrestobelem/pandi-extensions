/**
 * Durable test for the double-copy check added to extensions/pi-doctor/scripts/doctor.mjs.
 *
 * The dev setup loads this suite from the WORKING TREE (local path entries in project
 * and/or global settings). Installing a SECOND copy of the suite under a different pi
 * identity (git:… clone or npm:@pandi-coding-agent/… package) is not deduplicated by pi
 * (identity differs), so every extension/command/theme would load twice. doctor must
 * surface that mix as a warning BEFORE it bites.
 *
 * The global agent dir is injectable via PI_DOCTOR_AGENT_DIR — same seam style as
 * CLAUDE_GLOBAL_DIR for the sync check — so this test runs against throwaway tmp dirs
 * and never touches the real ~/.pi/agent.
 *
 * It pins:
 *   - Presence: doctor always prints an "instalación sin doble copia" line.
 *   - Clean: a global settings with only local-path/other packages reports OK (✓).
 *   - Mix (negative control): adding a git: copy of this suite flips the line to ⚠
 *     (the repo's project settings already load the working tree), so the check is
 *     not vacuous. An npm:@pandi-coding-agent/… copy also flips it.
 *   - Non-fatal: the state is OPTIONAL — a warning never contributes to the required
 *     failures that drive exit(1).
 *
 * We assert on stdout only (NO_COLOR), never on doctor's exit code, since that depends
 * on unrelated required tools present on the host / CI.
 *
 * Run it:
 *   node extensions/pi-dynamic-workflows/tests/integration/doctor-double-copy.test.mjs
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const DOCTOR = path.join(REPO_ROOT, "extensions", "pi-doctor", "scripts", "doctor.mjs");
const LABEL = "instalación sin doble copia";

const { check, counts } = createChecker();

function runDoctor(agentDir) {
	return spawnSync("node", [DOCTOR], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		env: { ...process.env, PI_DOCTOR_AGENT_DIR: agentDir, NO_COLOR: "1" },
	});
}

function makeAgentDir(packages) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-agent-"));
	fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ packages }, null, 2));
	return dir;
}

function lineFor(stdout) {
	return stdout.split("\n").find((l) => l.includes(LABEL));
}

function main() {
	// 1) Clean: unrelated/global-local packages only -> OK line present.
	const clean = runDoctor(makeAgentDir(["npm:pi-codex-web-search"]));
	const cleanLine = lineFor(clean.stdout);
	check("doctor prints the double-copy line", Boolean(cleanLine), `stdout tail: ${clean.stdout.slice(-300)}`);
	check("clean settings report OK (✓)", Boolean(cleanLine?.includes("✓")), `line: ${cleanLine}`);

	// 2) Mix: a git: copy of this suite next to the working-tree project settings -> ⚠.
	const gitMix = runDoctor(makeAgentDir(["git:github.com/andrestobelem/pi-dynamic-workflows@v0.1.0"]));
	const gitLine = lineFor(gitMix.stdout);
	check("a git: copy of the suite flips to a warning (⚠)", Boolean(gitLine?.includes("⚠")), `line: ${gitLine}`);

	// 3) Mix via npm scope: an npm:@pandi-coding-agent/… copy also flips to ⚠.
	const npmMix = runDoctor(makeAgentDir([{ source: "npm:@pandi-coding-agent/loop" }]));
	const npmLine = lineFor(npmMix.stdout);
	check("an npm scoped copy of the suite flips to a warning (⚠)", Boolean(npmLine?.includes("⚠")), `line: ${npmLine}`);

	// 4) Non-fatal: the warning never appears among required failures (it lives under Opcionales).
	const requiredBlock = gitMix.stdout.split("Opcionales:")[0];
	check(
		"double-copy warning is optional, not a required failure",
		!requiredBlock.includes(LABEL),
		`required block: ${requiredBlock.slice(-200)}`,
	);

	if (counts.failed > 0) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

main();
