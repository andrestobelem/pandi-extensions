import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { listFilesRec, readMaybe } from "../../lib/sync-file-tree.mjs";

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
