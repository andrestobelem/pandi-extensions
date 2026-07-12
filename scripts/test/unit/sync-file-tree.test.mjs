import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { findFileTreeDrift, listFilesRec, readMaybe } from "../../lib/sync-file-tree.mjs";

function writeFile(file, content) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

test("listFilesRec returns sorted relative files and tolerates missing roots", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-file-tree-"));
	try {
		writeFile(path.join(root, "b", "two.txt"), "2");
		writeFile(path.join(root, "a.txt"), "1");
		writeFile(path.join(root, "b", "one.txt"), "1");
		assert.deepEqual(await listFilesRec(root), ["a.txt", path.join("b", "one.txt"), path.join("b", "two.txt")]);
		assert.deepEqual(await listFilesRec(path.join(root, "missing")), []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("readMaybe returns utf8 content or null for missing files", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-file-tree-"));
	try {
		const file = path.join(root, "file.txt");
		writeFile(file, "hello\n");
		assert.equal(await readMaybe(file), "hello\n");
		assert.equal(await readMaybe(path.join(root, "missing.txt")), null);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("filesystem helpers rethrow errors other than missing paths", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-file-tree-"));
	try {
		const file = path.join(root, "file.txt");
		writeFile(file, "hello\n");

		await assert.rejects(() => listFilesRec(file), { code: "ENOTDIR" });
		await assert.rejects(() => readMaybe(path.join(file, "child.txt")), { code: "ENOTDIR" });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("findFileTreeDrift reports mismatched and stale files in deterministic order", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-file-tree-"));
	try {
		writeFile(path.join(root, "changed.txt"), "old\n");
		writeFile(path.join(root, "extra.txt"), "extra\n");
		const expected = new Map([
			["changed.txt", "new\n"],
			["missing.txt", "missing\n"],
		]);

		assert.deepEqual(await findFileTreeDrift(expected, root), [
			{ kind: "mismatch", relativePath: "changed.txt" },
			{ kind: "mismatch", relativePath: "missing.txt" },
			{ kind: "stale", relativePath: "extra.txt" },
		]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
