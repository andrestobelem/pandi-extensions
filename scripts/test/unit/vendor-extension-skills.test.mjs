import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	expectedFilesFor,
	parseCheckOnly,
	syncVendorExtensionSkills,
	vendoredSkillTargets,
} from "../../vendor-extension-skills.mjs";

function writeFile(root, rel, content) {
	const file = path.join(root, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function logs() {
	const lines = [];
	return { lines, log: (line) => lines.push(line), error: (line) => lines.push(line) };
}

test("vendor-extension-skills parses check mode and target paths", () => {
	assert.equal(parseCheckOnly(["--check"]), true);
	assert.equal(parseCheckOnly([]), false);
	assert.deepEqual(vendoredSkillTargets({ ext: ["alpha", "beta"] }, { repo: "/repo" }), [
		{ ext: "ext", skillName: "alpha", outRoot: path.join("/repo", "extensions", "ext", "skills", "alpha") },
		{ ext: "ext", skillName: "beta", outRoot: path.join("/repo", "extensions", "ext", "skills", "beta") },
	]);
});

test("expectedFilesFor reads the complete skill tree", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-skills-"));
	try {
		writeFile(path.join(root, "alpha"), "SKILL.md", "# alpha\n");
		writeFile(path.join(root, "alpha"), path.join("reference", "notes.md"), "notes\n");
		assert.deepEqual(
			[...(await expectedFilesFor("alpha", root))],
			[
				[path.join("reference", "notes.md"), "notes\n"],
				["SKILL.md", "# alpha\n"],
			],
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("syncVendorExtensionSkills rewrites vendored trees and removes stale files", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-skills-"));
	try {
		const skillsRoot = path.join(root, "skills");
		const repo = path.join(root, "repo");
		const classification = { vendoredByExtension: { "pandi-ext": ["alpha"] }, unclassified: [] };
		writeFile(path.join(skillsRoot, "alpha"), "SKILL.md", "# alpha\n");
		writeFile(path.join(repo, "extensions", "pandi-ext", "skills", "alpha"), "stale.txt", "old\n");

		const captured = logs();
		assert.deepEqual(
			await syncVendorExtensionSkills({
				classification,
				repo,
				skillsRoot,
				log: captured.log,
				error: captured.error,
			}),
			{ drift: 0, wrote: 1, treesWritten: 1, ok: true },
		);
		const outRoot = path.join(repo, "extensions", "pandi-ext", "skills", "alpha");
		assert.equal(fs.readFileSync(path.join(outRoot, "SKILL.md"), "utf8"), "# alpha\n");
		assert.equal(fs.existsSync(path.join(outRoot, "stale.txt")), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("syncVendorExtensionSkills reports check-mode drift and stale files", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-skills-"));
	try {
		const skillsRoot = path.join(root, "skills");
		const repo = path.join(root, "repo");
		const classification = { vendoredByExtension: { "pandi-ext": ["alpha"] }, unclassified: [] };
		writeFile(path.join(skillsRoot, "alpha"), "SKILL.md", "# wanted\n");
		const outRoot = path.join(repo, "extensions", "pandi-ext", "skills", "alpha");
		writeFile(outRoot, "SKILL.md", "# stale\n");
		writeFile(outRoot, "extra.txt", "extra\n");

		const captured = logs();
		assert.deepEqual(
			await syncVendorExtensionSkills({
				checkOnly: true,
				classification,
				repo,
				skillsRoot,
				log: captured.log,
				error: captured.error,
			}),
			{ drift: 2, wrote: 0, treesWritten: 0, ok: false },
		);
		assert.match(captured.lines.join("\n"), /drift: pandi-ext\/skills\/alpha\/SKILL.md/);
		assert.match(captured.lines.join("\n"), /stale/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
