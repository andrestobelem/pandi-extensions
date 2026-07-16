import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = path.join(REPO, "scripts", "sync-agents-global.mjs");
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
	const home = path.join(os.tmpdir(), "agents-home");
	assert.deepEqual(parseArgs(["--check", "--dest", "./out"], {}, home), {
		action: "status",
		dest: path.resolve("./out"),
	});
	assert.deepEqual(parseArgs([], { AGENTS_GLOBAL_DIR: "./env-out" }, home), {
		action: "status",
		dest: path.resolve("./env-out"),
	});
	assert.deepEqual(parseArgs(["install"], {}, home), {
		action: "install",
		dest: path.resolve(home, ".agents"),
	});
	assert.deepEqual(parseArgs(["remove"], {}, home), {
		action: "remove",
		dest: path.resolve(home, ".agents"),
	});
	assert.throws(() => parseArgs(["install", "--dest", "--check"], {}, home), /--dest requires a directory/);
	assert.throws(() => parseArgs(["prune"], {}, home), /expected status, install, or remove/);
});

test("ownership manifest has a stable reserved filename", () => {
	assert.equal(MANIFEST_NAME, ".pandi-extensions-managed.json");
});

test("walk returns recursive relative files and tolerates missing roots", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agents-global-walk-"));
	try {
		writeFile(path.join(root, "a.txt"));
		writeFile(path.join(root, "nested", "b.txt"));
		assert.deepEqual(walk(root).sort(), ["a.txt", path.join("nested", "b.txt")]);
		assert.deepEqual(walk(path.join(root, "missing")), []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("planPairs expands canonical .pi/skills trees for global project skills", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agents-global-plan-"));
	try {
		const dest = path.join(root, "dest");
		const skillsRoot = path.join(root, "skills");
		writeFile(path.join(skillsRoot, "skill-a", "SKILL.md"));
		writeFile(path.join(skillsRoot, "ultracode", "SKILL.md"));
		writeFile(path.join(skillsRoot, "ultracode", "reference", "primitives", "agent.md"));

		const pairs = planPairs(dest, { skillsRoot, projectSkills: ["skill-a", "ultracode"] });
		const got = relativePairs(root, pairs).sort((a, b) => `${a.src}->${a.dst}`.localeCompare(`${b.src}->${b.dst}`));
		const want = [
			{ src: "skills/skill-a/SKILL.md", dst: "dest/skills/skill-a/SKILL.md" },
			{
				src: "skills/ultracode/reference/primitives/agent.md",
				dst: "dest/skills/ultracode/reference/primitives/agent.md",
			},
			{ src: "skills/ultracode/SKILL.md", dst: "dest/skills/ultracode/SKILL.md" },
		].sort((a, b) => `${a.src}->${a.dst}`.localeCompare(`${b.src}->${b.dst}`));
		assert.deepEqual(got, want);
		assert.equal(new Set(pairs.map(({ dst }) => dst)).size, pairs.length);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
