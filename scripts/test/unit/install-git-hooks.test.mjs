import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { gitHooksConfigArgs, installGitHooks, shouldInstallGitHooks } from "../../install-git-hooks.mjs";

test("git hook helpers keep the versioned hooksPath contract", () => {
	assert.deepEqual(gitHooksConfigArgs(), ["config", "core.hooksPath", "scripts/git-hooks"]);
});

test("installGitHooks is a no-op outside a git checkout", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "install-hooks-"));
	try {
		let called = false;
		assert.equal(shouldInstallGitHooks(root), false);
		assert.deepEqual(
			installGitHooks(root, () => {
				called = true;
			}),
			{ skipped: true, status: 0 },
		);
		assert.equal(called, false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("installGitHooks configures core.hooksPath inside a git checkout", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "install-hooks-"));
	try {
		fs.mkdirSync(path.join(root, ".git"));
		let call;
		const result = installGitHooks(root, (cmd, args, opts) => {
			call = { cmd, args, opts };
			return { status: 0 };
		});
		assert.deepEqual(result, { skipped: false, status: 0 });
		assert.equal(call.cmd, "git");
		assert.deepEqual(call.args, ["config", "core.hooksPath", "scripts/git-hooks"]);
		assert.equal(call.opts.cwd, root);
		assert.equal(call.opts.encoding, "utf8");
		assert.equal(call.opts.timeout, 8000);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
