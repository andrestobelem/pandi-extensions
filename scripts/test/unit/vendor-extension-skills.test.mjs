import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as vendorExtensionSkills from "../../vendor-extension-skills.mjs";
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

test("replaceGeneratedTree preserves the previous tree when staging fails", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-skills-"));
	try {
		const outRoot = path.join(root, "skills", "alpha");
		writeFile(outRoot, "SKILL.md", "# previous\n");
		writeFile(outRoot, "keep.txt", "keep\n");
		const expected = new Map([
			["SKILL.md", "# next\n"],
			[path.join("reference", "notes.md"), "notes\n"],
		]);
		let stagingRoot;

		await assert.rejects(
			() =>
				vendorExtensionSkills.replaceGeneratedTree(expected, outRoot, {
					writeTree: async ([first], rootPath) => {
						stagingRoot = rootPath;
						writeFile(rootPath, first[0], first[1]);
						throw new Error("injected staging failure");
					},
				}),
			/injected staging failure/,
		);

		assert.equal(path.dirname(stagingRoot), path.dirname(outRoot));
		assert.match(path.basename(stagingRoot), /^alpha\.staging-/);
		assert.equal(fs.readFileSync(path.join(outRoot, "SKILL.md"), "utf8"), "# previous\n");
		assert.equal(fs.readFileSync(path.join(outRoot, "keep.txt"), "utf8"), "keep\n");
		assert.deepEqual(
			fs.readdirSync(path.dirname(outRoot)).filter((entry) => entry.startsWith("alpha.")),
			[],
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("replaceGeneratedTree validates the complete staging tree before swapping", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-skills-"));
	try {
		const outRoot = path.join(root, "skills", "alpha");
		writeFile(outRoot, "SKILL.md", "# previous\n");
		const expected = new Map([
			["SKILL.md", "# next\n"],
			[path.join("reference", "notes.md"), "notes\n"],
		]);

		await assert.rejects(
			() =>
				vendorExtensionSkills.replaceGeneratedTree(expected, outRoot, {
					writeTree: async ([first], stagingRoot) => writeFile(stagingRoot, first[0], first[1]),
				}),
			/incomplete staging tree/,
		);

		assert.equal(fs.readFileSync(path.join(outRoot, "SKILL.md"), "utf8"), "# previous\n");
		assert.deepEqual(
			fs.readdirSync(path.dirname(outRoot)).filter((entry) => entry.startsWith("alpha.")),
			[],
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("replaceGeneratedTree installs a complete tree when the destination does not exist", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-skills-"));
	try {
		const outRoot = path.join(root, "skills", "alpha");
		const expected = new Map([
			["SKILL.md", "# next\n"],
			[path.join("reference", "notes.md"), "notes\n"],
		]);

		assert.equal(await vendorExtensionSkills.replaceGeneratedTree(expected, outRoot), 2);

		assert.equal(fs.readFileSync(path.join(outRoot, "SKILL.md"), "utf8"), "# next\n");
		assert.equal(fs.readFileSync(path.join(outRoot, "reference", "notes.md"), "utf8"), "notes\n");
		assert.deepEqual(
			fs.readdirSync(path.dirname(outRoot)).filter((entry) => entry.startsWith("alpha.")),
			[],
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("replaceGeneratedTree preserves the previous tree when creating the backup fails", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-skills-"));
	try {
		const outRoot = path.join(root, "skills", "alpha");
		writeFile(outRoot, "SKILL.md", "# previous\n");
		writeFile(outRoot, "keep.txt", "keep\n");
		const expected = new Map([["SKILL.md", "# next\n"]]);

		await assert.rejects(
			() =>
				vendorExtensionSkills.replaceGeneratedTree(expected, outRoot, {
					renamePath: async () => {
						throw new Error("injected backup failure");
					},
				}),
			/injected backup failure/,
		);

		assert.equal(fs.readFileSync(path.join(outRoot, "SKILL.md"), "utf8"), "# previous\n");
		assert.equal(fs.readFileSync(path.join(outRoot, "keep.txt"), "utf8"), "keep\n");
		assert.deepEqual(
			fs.readdirSync(path.dirname(outRoot)).filter((entry) => entry.startsWith("alpha.")),
			[],
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("replaceGeneratedTree rolls back when installing staging fails", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-skills-"));
	try {
		const outRoot = path.join(root, "skills", "alpha");
		writeFile(outRoot, "SKILL.md", "# previous\n");
		writeFile(outRoot, "keep.txt", "keep\n");
		const expected = new Map([["SKILL.md", "# next\n"]]);
		let renameCalls = 0;

		await assert.rejects(
			() =>
				vendorExtensionSkills.replaceGeneratedTree(expected, outRoot, {
					renamePath: async (from, to) => {
						renameCalls++;
						if (renameCalls === 2) throw new Error("injected install failure");
						await fs.promises.rename(from, to);
					},
				}),
			/injected install failure/,
		);

		assert.equal(renameCalls, 3);
		assert.equal(fs.readFileSync(path.join(outRoot, "SKILL.md"), "utf8"), "# previous\n");
		assert.equal(fs.readFileSync(path.join(outRoot, "keep.txt"), "utf8"), "keep\n");
		assert.deepEqual(
			fs.readdirSync(path.dirname(outRoot)).filter((entry) => entry.startsWith("alpha.")),
			[],
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("replaceGeneratedTree does not mask a swap failure when best-effort cleanup fails", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-skills-"));
	try {
		const outRoot = path.join(root, "skills", "alpha");
		writeFile(outRoot, "SKILL.md", "# previous\n");
		const expected = new Map([["SKILL.md", "# next\n"]]);
		let renameCalls = 0;
		let cleanupFailures = 0;

		await assert.rejects(
			() =>
				vendorExtensionSkills.replaceGeneratedTree(expected, outRoot, {
					renamePath: async (from, to) => {
						renameCalls++;
						if (renameCalls === 2) throw new Error("injected install failure");
						await fs.promises.rename(from, to);
					},
					removePath: async (target, options) => {
						await fs.promises.rm(target, options);
						if (path.basename(target).startsWith("alpha.staging-")) {
							cleanupFailures++;
							throw new Error("injected cleanup failure");
						}
					},
				}),
			/injected install failure/,
		);

		assert.equal(cleanupFailures, 1);
		assert.equal(fs.readFileSync(path.join(outRoot, "SKILL.md"), "utf8"), "# previous\n");
		assert.deepEqual(
			fs.readdirSync(path.dirname(outRoot)).filter((entry) => entry.startsWith("alpha.")),
			[],
		);
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
