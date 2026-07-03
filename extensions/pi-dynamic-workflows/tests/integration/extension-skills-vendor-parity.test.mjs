/**
 * Durable parity test for VENDORED extension skills: the skills owned by pi-dynamic-workflows
 * (ultracode, deep-research, default) are authored canonically under `.pi/skills/<name>/` and
 * mirrored verbatim into `extensions/pi-dynamic-workflows/skills/<name>/` by
 * `scripts/vendor-extension-skills.mjs` (source of truth = .pi/skills), so the extension carries
 * its own skills when installed standalone (`pi install ./extensions/pi-dynamic-workflows`).
 *
 * This pins:
 *   - In sync: `vendor-extension-skills.mjs --check` exits 0 (every vendored copy byte-equals its
 *     .pi source and there are no stale files). Fails if anyone hand-edits one copy or the source
 *     without regenerating.
 *   - A concrete vendored file (ultracode/SKILL.md) is byte-identical to its .pi source.
 *   - Sensitivity (negative control): a one-character tweak to a vendored copy is detected as
 *     drift (exit 1), then reverted, so the check is not vacuous.
 *
 * The self-hosted repo loads these skills via `.pi/skills/` auto-discovery; the extension package
 * entry in `.pi/settings.json` filters skills to `[]` so the vendored copy does NOT double-load
 * in-repo. That layout concern is orthogonal to this byte-parity check.
 *
 * No extension build / no model: a pure filesystem + script-process test.
 *
 * Run it:
 *   node extensions/pi-dynamic-workflows/tests/integration/extension-skills-vendor-parity.test.mjs
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const GEN = path.join(REPO_ROOT, "scripts", "vendor-extension-skills.mjs");

const { check, counts } = createChecker();

function runCheck() {
	return spawnSync("node", [GEN, "--check"], { cwd: REPO_ROOT, encoding: "utf8" });
}

function main() {
	check("vendor-extension-skills.mjs exists", fs.existsSync(GEN));

	// 1) All vendored skills in sync.
	const res = runCheck();
	check(
		"vendor-extension-skills.mjs --check is in sync (extension copies == .pi sources)",
		res.status === 0,
		`exit=${res.status} ${(res.stderr || res.stdout || "").trim().split("\n").slice(-2).join(" | ")}`,
	);

	// The ultracode skill is the concrete vendored pair: assert byte-identity directly.
	const piSkill = path.join(REPO_ROOT, ".pi", "skills", "ultracode", "SKILL.md");
	const vendoredSkill = path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "skills", "ultracode", "SKILL.md");
	check("ultracode skill exists in .pi (source of truth)", fs.existsSync(piSkill));
	check("ultracode skill exists in the extension (vendored)", fs.existsSync(vendoredSkill));
	if (fs.existsSync(piSkill) && fs.existsSync(vendoredSkill)) {
		const a = fs.readFileSync(piSkill, "utf8");
		const b = fs.readFileSync(vendoredSkill, "utf8");
		check(
			"vendored ultracode SKILL.md is byte-identical to the .pi source",
			a === b && a.length > 100,
			`pi=${a.length} vendored=${b.length}`,
		);
	}

	// 2) Sensitivity: mutate a vendored copy by one char and confirm --check catches it, then revert.
	if (fs.existsSync(vendoredSkill)) {
		const original = fs.readFileSync(vendoredSkill, "utf8");
		try {
			fs.writeFileSync(vendoredSkill, `${original}\n<!-- drift -->\n`);
			const drifted = runCheck();
			check(
				"a one-line tweak to a vendored copy is detected as drift (exit 1)",
				drifted.status === 1,
				`exit=${drifted.status}`,
			);
		} finally {
			fs.writeFileSync(vendoredSkill, original);
		}
		// Confirm the revert restored sync (guards against leaving the tree dirty).
		check("vendored copy restored to in-sync after the negative control", runCheck().status === 0);
	}

	// 3) BEHAVIOR invariants the vendoring exists for (not just byte parity). These are the two
	// comment-only promises the design rests on; pin them so a config edit can't silently break them.
	//   (a) The extension SHIPS its skills: package.json files[] carries "skills" and pi.skills points
	//       at "./skills", so `pi install ./extensions/pi-dynamic-workflows` includes + loads them.
	//   (b) In-repo does NOT double-load: the pi-dynamic-workflows entry in .pi/settings.json is
	//       object-form with skills:[] (the repo already loads these via .pi/skills auto-discovery).
	const extPkgPath = path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "package.json");
	const extPkg = JSON.parse(fs.readFileSync(extPkgPath, "utf8"));
	check(
		'extension package.json files[] includes "skills" (vendored tree ships in the tarball)',
		Array.isArray(extPkg.files) && extPkg.files.includes("skills"),
		`files=${JSON.stringify(extPkg.files)}`,
	);
	check(
		'extension pi.skills includes "./skills" (Pi loads the vendored tree when installed standalone)',
		Array.isArray(extPkg.pi?.skills) && extPkg.pi.skills.includes("./skills"),
		`pi.skills=${JSON.stringify(extPkg.pi?.skills)}`,
	);

	const settingsPath = path.join(REPO_ROOT, ".pi", "settings.json");
	const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	const dwEntry = (Array.isArray(settings.packages) ? settings.packages : []).find(
		(p) => typeof p === "object" && p !== null && String(p.source || "").endsWith("pi-dynamic-workflows"),
	);
	check(
		"in-repo .pi/settings.json filters pi-dynamic-workflows skills:[] (no double-load with .pi/skills)",
		!!dwEntry && Array.isArray(dwEntry.skills) && dwEntry.skills.length === 0,
		`entry=${JSON.stringify(dwEntry)}`,
	);

	if (counts.failed > 0) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

main();
