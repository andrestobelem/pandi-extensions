import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = path.join(REPO, "scripts", "sync-claude-global.mjs");
const { parseArgs, planPairs, walk } = await import(pathToFileURL(SCRIPT).href);

function writeFile(file, content = "x") {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function relativePairs(root, pairs) {
	return pairs
		.map(({ src, dst }) => ({ src: path.relative(root, src), dst: path.relative(root, dst) }))
		.sort((a, b) => `${a.src}->${a.dst}`.localeCompare(`${b.src}->${b.dst}`));
}

test("parseArgs resolves check and destination from flags, env, or home", () => {
	const home = path.join(os.tmpdir(), "claude-home");
	assert.deepEqual(parseArgs(["--check", "--dest", "./out"], {}, home), {
		checkOnly: true,
		dest: path.resolve("./out"),
	});
	assert.deepEqual(parseArgs([], { CLAUDE_GLOBAL_DIR: "./env-out" }, home), {
		checkOnly: false,
		dest: path.resolve("./env-out"),
	});
	assert.deepEqual(parseArgs([], {}, home), {
		checkOnly: false,
		dest: path.resolve(home, ".claude"),
	});
});

test("walk returns recursive relative files and tolerates missing roots", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-global-walk-"));
	try {
		writeFile(path.join(root, "a.txt"));
		writeFile(path.join(root, "nested", "b.txt"));
		assert.deepEqual(walk(root).sort(), ["a.txt", path.join("nested", "b.txt")]);
		assert.deepEqual(walk(path.join(root, "missing")), []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("planPairs expands workflows, runtime helpers, project skills, and primitives", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-global-plan-"));
	try {
		const dest = path.join(root, "dest");
		const repoRoot = path.join(root, "repo");
		const skillsRoot = path.join(repoRoot, ".pi", "skills");
		writeFile(path.join(repoRoot, ".claude", "workflows", "w.js"));
		writeFile(path.join(repoRoot, ".claude", "scripts", "build-workflow-artifact.mjs"));
		writeFile(path.join(repoRoot, ".claude", "scripts", "lib", "artifact.mjs"));
		writeFile(path.join(repoRoot, ".claude", "skills", "skill-a", "SKILL.md"));
		writeFile(path.join(skillsRoot, "ultracode", "reference", "primitives", "agent.md"));

		assert.deepEqual(relativePairs(root, planPairs(dest, { repoRoot, skillsRoot, projectSkills: ["skill-a"] })), [
			{ src: "repo/.claude/scripts/build-workflow-artifact.mjs", dst: "dest/scripts/build-workflow-artifact.mjs" },
			{ src: "repo/.claude/scripts/lib/artifact.mjs", dst: "dest/scripts/lib/artifact.mjs" },
			{ src: "repo/.claude/skills/skill-a/SKILL.md", dst: "dest/skills/skill-a/SKILL.md" },
			{ src: "repo/.claude/workflows/w.js", dst: "dest/workflows/w.js" },
			{
				src: "repo/.pi/skills/ultracode/reference/primitives/agent.md",
				dst: "dest/skills/ultracode/reference/primitives/agent.md",
			},
		]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
