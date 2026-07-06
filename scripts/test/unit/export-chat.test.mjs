import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { chatExportPath, latestSessionFile } from "../../export-chat.mjs";

function writeSession(file, mtime) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "{}\n");
	fs.utimesSync(file, mtime, mtime);
}

test("latestSessionFile returns the most recently modified jsonl session", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "export-chat-"));
	try {
		const oldFile = path.join(root, "old.jsonl");
		const newFile = path.join(root, "new.jsonl");
		writeSession(oldFile, new Date("2026-01-01T00:00:00Z"));
		writeSession(newFile, new Date("2026-01-02T00:00:00Z"));
		fs.writeFileSync(path.join(root, "ignore.txt"), "x");
		assert.equal(latestSessionFile(root), newFile);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("latestSessionFile returns null for missing or empty session dirs", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "export-chat-"));
	try {
		assert.equal(latestSessionFile(path.join(root, "missing")), null);
		assert.equal(latestSessionFile(root), null);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("chatExportPath mirrors the native pi export filename", () => {
	assert.equal(
		chatExportPath(path.join("sessions", "abc.jsonl"), path.join(".pi", "chats")),
		path.join(".pi", "chats", "pi-session-abc.html"),
	);
});
