import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = path.join(REPO, "scripts", "sync-claude-global.mjs");
const { MANIFEST_NAME, parseArgs, planPairs, walk } = await import(pathToFileURL(SCRIPT).href);

function writeFile(file, content = "x") {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function relativePairs(root, pairs) {
	return pairs
		.map(({ src, dst }) => ({ src: path.relative(root, src), dst: path.relative(root, dst) }))
		.sort((a, b) => `${a.src}->${a.dst}`.localeCompare(`${b.src}->${b.dst}`));
}

test("parseArgs defaults to read-only status and resolves explicit actions and destination", () => {
	const home = path.join(os.tmpdir(), "claude-home");
	assert.deepEqual(parseArgs(["--check", "--dest", "./out"], {}, home), {
		action: "status",
		dest: path.resolve("./out"),
	});
	assert.deepEqual(parseArgs([], { CLAUDE_GLOBAL_DIR: "./env-out" }, home), {
		action: "status",
		dest: path.resolve("./env-out"),
	});
	assert.deepEqual(parseArgs(["install"], {}, home), {
		action: "install",
		dest: path.resolve(home, ".claude"),
	});
	assert.deepEqual(parseArgs(["remove"], {}, home), {
		action: "remove",
		dest: path.resolve(home, ".claude"),
	});
	assert.throws(() => parseArgs(["install", "--dest", "--check"], {}, home), /--dest requires a directory/);
	assert.throws(() => parseArgs(["install", "--dest", "remove"], {}, home), /--dest requires a directory/);
	assert.throws(() => parseArgs(["prune"], {}, home), /expected status, install, or remove/);
});

test("ownership manifest has a stable reserved filename", () => {
	assert.equal(MANIFEST_NAME, ".pandi-extensions-managed.json");
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
		writeFile(path.join(repoRoot, ".claude", "skills", "ultracode", "SKILL.md"));
		writeFile(path.join(repoRoot, ".claude", "skills", "ultracode", "reference", "primitives", "agent.md"), "mirror");
		writeFile(path.join(skillsRoot, "ultracode", "reference", "primitives", "agent.md"));

		const pairs = planPairs(dest, { repoRoot, skillsRoot, projectSkills: ["skill-a", "ultracode"] });
		assert.deepEqual(relativePairs(root, pairs), [
			{ src: "repo/.claude/scripts/build-workflow-artifact.mjs", dst: "dest/scripts/build-workflow-artifact.mjs" },
			{ src: "repo/.claude/scripts/lib/artifact.mjs", dst: "dest/scripts/lib/artifact.mjs" },
			{ src: "repo/.claude/skills/skill-a/SKILL.md", dst: "dest/skills/skill-a/SKILL.md" },
			{ src: "repo/.claude/skills/ultracode/SKILL.md", dst: "dest/skills/ultracode/SKILL.md" },
			{ src: "repo/.claude/workflows/w.js", dst: "dest/workflows/w.js" },
			{
				src: "repo/.pi/skills/ultracode/reference/primitives/agent.md",
				dst: "dest/skills/ultracode/reference/primitives/agent.md",
			},
		]);
		assert.equal(new Set(pairs.map(({ dst }) => dst)).size, pairs.length);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
