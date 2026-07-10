import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const HOOK_PATH = path.resolve(import.meta.dirname, "../../git-hooks/commit-msg");

function runHook(messagePath) {
	return spawnSync("sh", [HOOK_PATH, messagePath], { encoding: "utf8" });
}

function writeTemp(prefix, content) {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const tmpFile = path.join(tmpDir, "msg.txt");
	fs.writeFileSync(tmpFile, content, "utf8");
	return { tmpDir, tmpFile };
}

function cleanup(tmpDir) {
	fs.rmSync(tmpDir, { recursive: true, force: true });
}

test("commit-msg hook allows messages without Co-authored-by", () => {
	const { tmpDir, tmpFile } = writeTemp("commit-msg-good-", "feat(pandi): do something\n\nBody text.\n");
	try {
		const r = runHook(tmpFile);
		assert.equal(r.status, 0, r.stderr);
	} finally {
		cleanup(tmpDir);
	}
});

test("commit-msg hook blocks Co-authored-by: Cursor", () => {
	const { tmpDir, tmpFile } = writeTemp(
		"commit-msg-cursor-",
		"feat(pandi): do something\n\nBody text.\n\nCo-authored-by: Cursor <cursoragent@cursor.com>\n",
	);
	try {
		const r = runHook(tmpFile);
		assert.notEqual(r.status, 0);
		assert.match(r.stderr, /Co-authored-by/i);
	} finally {
		cleanup(tmpDir);
	}
});

test("commit-msg hook blocks any Co-authored-by line", () => {
	const { tmpDir, tmpFile } = writeTemp(
		"commit-msg-human-",
		"feat(pandi): do something\n\nCo-authored-by: Ada Lovelace <ada@example.com>\n",
	);
	try {
		const r = runHook(tmpFile);
		assert.notEqual(r.status, 0);
		assert.match(r.stderr, /BLOQUEADO/);
	} finally {
		cleanup(tmpDir);
	}
});

test("commit-msg hook ignores Co-authored-by not at line start", () => {
	const { tmpDir, tmpFile } = writeTemp(
		"commit-msg-inline-",
		"docs(pandi): mention Co-authored-by: in the rules\n\nThis explains why we block Co-authored-by lines.\n",
	);
	try {
		const r = runHook(tmpFile);
		assert.equal(r.status, 0, r.stderr);
	} finally {
		cleanup(tmpDir);
	}
});
