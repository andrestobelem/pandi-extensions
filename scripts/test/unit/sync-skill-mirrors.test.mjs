import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { mirroredSkillPairs, parseCheckOnly, syncSkillMirrors } from "../../sync-skill-mirrors.mjs";

function writeSkill(root, name, content) {
	const file = path.join(root, name, "SKILL.md");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function writeFile(file, content) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function logs() {
	const lines = [];
	return { lines, log: (line) => lines.push(line), error: (line) => lines.push(line) };
}

test("parseCheckOnly detects check mode without parsing unrelated flags", () => {
	assert.equal(parseCheckOnly(["--check"]), true);
	assert.equal(parseCheckOnly(["--dest", "tmp"]), false);
});

test("mirroredSkillPairs maps skill names to canonical source and Claude mirror paths", () => {
	assert.deepEqual(mirroredSkillPairs(["alpha"], { repo: "/repo", skillsRoot: "/skills" }), [
		{
			name: "alpha",
			src: path.join("/skills", "alpha"),
			dst: path.join("/repo", ".claude", "skills", "alpha"),
		},
	]);
});

test("syncSkillMirrors writes missing mirrors and check mode accepts the result", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-mirrors-"));
	try {
		const skillsRoot = path.join(root, "skills");
		const repo = path.join(root, "repo");
		const classification = { mirrored: ["alpha"], unclassified: [] };
		writeSkill(skillsRoot, "alpha", "# alpha\n");
		writeFile(path.join(skillsRoot, "alpha", "references", "details.md"), "details\n");

		const writeLog = logs();
		assert.deepEqual(
			await syncSkillMirrors({ classification, repo, skillsRoot, log: writeLog.log, error: writeLog.error }),
			{ drift: 0, wrote: 1, total: 1, ok: true },
		);
		assert.equal(fs.readFileSync(path.join(repo, ".claude", "skills", "alpha", "SKILL.md"), "utf8"), "# alpha\n");
		assert.equal(
			fs.readFileSync(path.join(repo, ".claude", "skills", "alpha", "references", "details.md"), "utf8"),
			"details\n",
		);

		const checkLog = logs();
		assert.deepEqual(
			await syncSkillMirrors({
				checkOnly: true,
				classification,
				repo,
				skillsRoot,
				log: checkLog.log,
				error: checkLog.error,
			}),
			{ drift: 0, wrote: 0, total: 1, ok: true },
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("syncSkillMirrors reports check-mode drift without writing", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-mirrors-"));
	try {
		const skillsRoot = path.join(root, "skills");
		const repo = path.join(root, "repo");
		const classification = { mirrored: ["alpha"], unclassified: [] };
		writeSkill(skillsRoot, "alpha", "# wanted\n");
		writeSkill(path.join(repo, ".claude", "skills"), "alpha", "# stale\n");
		writeFile(path.join(repo, ".claude", "skills", "alpha", "references", "stale.md"), "stale\n");

		const captured = logs();
		assert.deepEqual(
			await syncSkillMirrors({
				checkOnly: true,
				classification,
				repo,
				skillsRoot,
				log: captured.log,
				error: captured.error,
			}),
			{ drift: 1, wrote: 0, total: 1, ok: false },
		);
		assert.equal(fs.readFileSync(path.join(repo, ".claude", "skills", "alpha", "SKILL.md"), "utf8"), "# stale\n");
		assert.ok(fs.existsSync(path.join(repo, ".claude", "skills", "alpha", "references", "stale.md")));
		assert.match(captured.lines.join("\n"), /drift: alpha/);

		assert.deepEqual(
			await syncSkillMirrors({ classification, repo, skillsRoot, log: captured.log, error: captured.error }),
			{ drift: 0, wrote: 1, total: 1, ok: true },
		);
		assert.equal(fs.readFileSync(path.join(repo, ".claude", "skills", "alpha", "SKILL.md"), "utf8"), "# wanted\n");
		assert.equal(fs.existsSync(path.join(repo, ".claude", "skills", "alpha", "references", "stale.md")), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
