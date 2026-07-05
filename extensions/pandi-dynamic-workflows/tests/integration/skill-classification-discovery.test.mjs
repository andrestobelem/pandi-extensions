import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const LIVE_SKILLS_ROOT = path.join(REPO_ROOT, ".pi", "skills");
const CLASSIFICATION = path.join(REPO_ROOT, "scripts", "skill-classification.mjs");
const MIRRORS = path.join(REPO_ROOT, "scripts", "sync-skill-mirrors.mjs");
const VENDOR = path.join(REPO_ROOT, "scripts", "vendor-extension-skills.mjs");
const CLAUDE = path.join(REPO_ROOT, "scripts", "sync-claude-global.mjs");

const { check, counts } = createChecker();

function runNode(script, args = [], env = {}) {
	return spawnSync("node", [script, ...args], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
}

function hasUnclassifiedDiagnostic(result, skillName) {
	return `${result.stdout}${result.stderr}`.includes(`unclassified skill: ${skillName}`);
}

function hasMissingSourceDiagnostic(result, skillName) {
	return `${result.stdout}${result.stderr}`.includes(`missing source: .pi/skills/${skillName}/`);
}

function withTempSkillsRoot(fn) {
	const skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pandi-skills-root-"));
	fs.cpSync(LIVE_SKILLS_ROOT, skillsRoot, { recursive: true });
	try {
		fn(skillsRoot, { PANDI_SKILLS_ROOT: skillsRoot });
	} finally {
		fs.rmSync(skillsRoot, { recursive: true, force: true });
	}
}

function withMissingSkill(skillsRoot, skillName, fn) {
	const skillDir = path.join(skillsRoot, skillName);
	const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${skillName}-backup-`));
	const backupDir = path.join(backupRoot, skillName);
	fs.cpSync(skillDir, backupDir, { recursive: true });
	fs.rmSync(skillDir, { recursive: true, force: true });
	try {
		fn();
	} finally {
		fs.cpSync(backupDir, skillDir, { recursive: true });
		fs.rmSync(backupRoot, { recursive: true, force: true });
	}
}

function finish() {
	if (counts.failed > 0) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

function main() {
	check("skill-classification.mjs exists", fs.existsSync(CLASSIFICATION));
	check("sync-skill-mirrors.mjs exists", fs.existsSync(MIRRORS));
	check("vendor-extension-skills.mjs exists", fs.existsSync(VENDOR));
	check("sync-claude-global.mjs exists", fs.existsSync(CLAUDE));
	if (!fs.existsSync(CLASSIFICATION) || !fs.existsSync(MIRRORS) || !fs.existsSync(VENDOR) || !fs.existsSync(CLAUDE)) {
		return finish();
	}

	// Negative controls must not mutate the live .pi/skills tree: other integration suites run
	// in parallel and classify that tree. A transient __unclassified-skill-* directory there
	// caused flakes in skill-mirror-parity / sync:check:all. The scripts honor PANDI_SKILLS_ROOT
	// so each destructive check below runs against this private copy instead.
	withTempSkillsRoot((skillsRoot, env) => {
		withMissingSkill(skillsRoot, "github-project", () => {
			const mirrorCheck = runNode(MIRRORS, ["--check"], env);
			check(
				"sync-skill-mirrors --check fails when a mirrored skill source is missing",
				mirrorCheck.status === 1 && hasMissingSourceDiagnostic(mirrorCheck, "github-project"),
				`exit=${mirrorCheck.status} out=${JSON.stringify(`${mirrorCheck.stdout}${mirrorCheck.stderr}`)}`,
			);
		});

		withMissingSkill(skillsRoot, "deep-research", () => {
			const vendorCheck = runNode(VENDOR, ["--check"], env);
			check(
				"vendor-extension-skills --check fails when a vendored skill source is missing",
				vendorCheck.status === 1 && hasMissingSourceDiagnostic(vendorCheck, "deep-research"),
				`exit=${vendorCheck.status} out=${JSON.stringify(`${vendorCheck.stdout}${vendorCheck.stderr}`)}`,
			);
		});

		const unclassifiedDir = fs.mkdtempSync(path.join(skillsRoot, "__unclassified-skill-"));
		const skillName = path.basename(unclassifiedDir);
		const tmpClaude = fs.mkdtempSync(path.join(os.tmpdir(), "claude-global-"));
		try {
			fs.writeFileSync(path.join(unclassifiedDir, "SKILL.md"), "# temp unclassified skill\n");

			const mirrorCheck = runNode(MIRRORS, ["--check"], env);
			check(
				"sync-skill-mirrors --check fails on an unclassified discovered skill",
				mirrorCheck.status === 1 && hasUnclassifiedDiagnostic(mirrorCheck, skillName),
				`exit=${mirrorCheck.status} out=${JSON.stringify(`${mirrorCheck.stdout}${mirrorCheck.stderr}`)}`,
			);

			const vendorCheck = runNode(VENDOR, ["--check"], env);
			check(
				"vendor-extension-skills --check fails on an unclassified discovered skill",
				vendorCheck.status === 1 && hasUnclassifiedDiagnostic(vendorCheck, skillName),
				`exit=${vendorCheck.status} out=${JSON.stringify(`${vendorCheck.stdout}${vendorCheck.stderr}`)}`,
			);

			const claudeSync = runNode(CLAUDE, ["--dest", tmpClaude], env);
			check(
				"sync-claude-global can seed a clean destination before the discovery check",
				claudeSync.status === 0,
				`exit=${claudeSync.status} out=${JSON.stringify(`${claudeSync.stdout}${claudeSync.stderr}`)}`,
			);

			const claudeCheck = runNode(CLAUDE, ["--dest", tmpClaude, "--check"], env);
			check(
				"sync-claude-global --check fails on an unclassified discovered skill",
				claudeCheck.status === 1 && hasUnclassifiedDiagnostic(claudeCheck, skillName),
				`exit=${claudeCheck.status} out=${JSON.stringify(`${claudeCheck.stdout}${claudeCheck.stderr}`)}`,
			);
		} finally {
			fs.rmSync(unclassifiedDir, { recursive: true, force: true });
			fs.rmSync(tmpClaude, { recursive: true, force: true });
		}
	});

	finish();
}

main();
