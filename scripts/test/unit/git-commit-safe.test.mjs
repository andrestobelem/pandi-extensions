import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createVerifiedCommit, runGitHook } from "../../lib/git-commit-safe.mjs";

function initRepo(root) {
	spawnSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
	spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root, stdio: "ignore" });
	spawnSync("git", ["config", "user.name", "Test"], { cwd: root, stdio: "ignore" });
	fs.mkdirSync(path.join(root, "scripts", "git-hooks"), { recursive: true });
}

test("runGitHook fails closed when the hook exits non-zero", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-hook-fail-"));
	const hook = path.join(root, "fail.sh");
	try {
		fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", "utf8");
		fs.chmodSync(hook, 0o755);
		assert.throws(() => runGitHook(root, hook), /failed \(exit 1\)/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("createVerifiedCommit blocks Co-authored-by trailers via commit-msg hook", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-commit-safe-"));
	const hooksDir = path.join(root, "scripts", "git-hooks");
	try {
		initRepo(root);
		fs.copyFileSync(
			path.resolve(import.meta.dirname, "../../git-hooks/commit-msg"),
			path.join(hooksDir, "commit-msg"),
		);
		fs.writeFileSync(path.join(root, "README.md"), "# test\n", "utf8");
		spawnSync("git", ["add", "README.md"], { cwd: root, stdio: "ignore" });
		spawnSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });

		fs.writeFileSync(path.join(root, "note.txt"), "change\n", "utf8");
		spawnSync("git", ["add", "note.txt"], { cwd: root, stdio: "ignore" });

		fs.writeFileSync(path.join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 0\n", "utf8");
		fs.chmodSync(path.join(hooksDir, "pre-commit"), 0o755);
		fs.chmodSync(path.join(hooksDir, "commit-msg"), 0o755);

		const sha = createVerifiedCommit({
			root,
			message: "feat(pandi): safe commit\n",
			hooksDir: "scripts/git-hooks",
		});
		assert.match(sha, /^[0-9a-f]{40}$/);

		const show = spawnSync("git", ["show", "-s", "--format=%B", sha], { cwd: root, encoding: "utf8" });
		assert.equal(show.status, 0);
		assert.match(show.stdout, /feat\(pandi\): safe commit/);
		assert.doesNotMatch(show.stdout, /Co-authored-by/i);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
