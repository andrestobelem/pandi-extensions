import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	expectedFilesFor,
	parseCheckOnly,
	syncClaudeUltracodeSkills,
	TARGETS,
	targetRoots,
	transformSkill,
} from "../../generate-claude-ultracode-skills.mjs";

function writeFile(root, rel, content) {
	const file = path.join(root, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function logs() {
	const lines = [];
	return { lines, log: (line) => lines.push(line), error: (line) => lines.push(line) };
}

test("generate-claude-ultracode helpers expose target and check-mode contracts", () => {
	assert.deepEqual(TARGETS, ["ultracode", "dynamic-workflows"]);
	assert.equal(parseCheckOnly(["--check"]), true);
	assert.deepEqual(targetRoots(["alpha"], "/out"), [{ target: "alpha", outRoot: path.join("/out", "alpha") }]);
});

test("transformSkill only renames the frontmatter name and H1 heading", () => {
	assert.equal(
		transformSkill("---\nname: ultracode\n---\n# ultracode\nbody ultracode\n", "dynamic-workflows"),
		"---\nname: dynamic-workflows\n---\n# dynamic-workflows\nbody ultracode\n",
	);
});

test("expectedFilesFor transforms SKILL.md and copies reference files verbatim", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-ultracode-"));
	try {
		writeFile(root, "SKILL.md", "---\nname: ultracode\n---\n# ultracode\n");
		writeFile(root, path.join("reference", "notes.md"), "notes\n");
		assert.deepEqual(
			[...(await expectedFilesFor("dynamic-workflows", root))],
			[
				["SKILL.md", "---\nname: dynamic-workflows\n---\n# dynamic-workflows\n"],
				[path.join("reference", "notes.md"), "notes\n"],
			],
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("syncClaudeUltracodeSkills writes generated targets and check mode accepts them", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-ultracode-"));
	try {
		const src = path.join(root, "src");
		const outDir = path.join(root, "out");
		writeFile(src, "SKILL.md", "---\nname: ultracode\n---\n# ultracode\n");
		writeFile(src, path.join("reference", "notes.md"), "notes\n");

		const writeLog = logs();
		assert.deepEqual(
			await syncClaudeUltracodeSkills({
				targets: ["dynamic-workflows"],
				src,
				outDir,
				log: writeLog.log,
				error: writeLog.error,
			}),
			{ drift: 0, wrote: 2, total: 1, ok: true },
		);
		assert.equal(
			fs.readFileSync(path.join(outDir, "dynamic-workflows", "SKILL.md"), "utf8"),
			"---\nname: dynamic-workflows\n---\n# dynamic-workflows\n",
		);

		const checkLog = logs();
		assert.deepEqual(
			await syncClaudeUltracodeSkills({
				checkOnly: true,
				targets: ["dynamic-workflows"],
				src,
				outDir,
				log: checkLog.log,
				error: checkLog.error,
			}),
			{ drift: 0, wrote: 0, total: 1, ok: true },
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("syncClaudeUltracodeSkills reports check-mode stale files", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-ultracode-"));
	try {
		const src = path.join(root, "src");
		const outDir = path.join(root, "out");
		writeFile(src, "SKILL.md", "---\nname: ultracode\n---\n# ultracode\n");
		writeFile(path.join(outDir, "ultracode"), "SKILL.md", "stale\n");
		writeFile(path.join(outDir, "ultracode"), "extra.txt", "extra\n");

		const captured = logs();
		assert.deepEqual(
			await syncClaudeUltracodeSkills({
				checkOnly: true,
				targets: ["ultracode"],
				src,
				outDir,
				log: captured.log,
				error: captured.error,
			}),
			{ drift: 2, wrote: 0, total: 1, ok: false },
		);
		assert.match(captured.lines.join("\n"), /drift: ultracode\/SKILL.md/);
		assert.match(captured.lines.join("\n"), /stale/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
