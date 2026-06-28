#!/usr/bin/env node
// Export a Pi session to HTML under .pi/chats/ (the repo's gitignored chat home).
//
// Pi's built-in `/export` writes the HTML into the current working directory and
// has no setting for a default destination directory. This helper makes the
// "chats live in .pi/chats/" convention real and repeatable by delegating to the
// supported `pi --export <in> <out>` CLI and writing the output there.
//
// Usage:
//   node scripts/export-chat.mjs                 # export the most recent session
//   node scripts/export-chat.mjs <session.jsonl> # export a specific session file
//
// Output name mirrors Pi's native export: pi-session-<sessionBasename>.html

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);
const SESSIONS_DIR = join(REPO_ROOT, ".pi", "sessions");
const CHATS_DIR = join(REPO_ROOT, ".pi", "chats");

// Resolve the session file: an explicit argument wins, else the most recently
// modified *.jsonl in .pi/sessions/ (i.e. the current/last session).
function resolveSessionFile(arg) {
	if (arg) {
		const p = resolve(arg);
		if (!existsSync(p)) {
			console.error(`Session file not found: ${p}`);
			process.exit(1);
		}
		return p;
	}
	if (!existsSync(SESSIONS_DIR)) {
		console.error(`No sessions directory at ${SESSIONS_DIR}`);
		process.exit(1);
	}
	const jsonls = readdirSync(SESSIONS_DIR)
		.filter((n) => n.endsWith(".jsonl"))
		.map((n) => join(SESSIONS_DIR, n))
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
	if (jsonls.length === 0) {
		console.error(`No .jsonl sessions found in ${SESSIONS_DIR}`);
		process.exit(1);
	}
	return jsonls[0];
}

const sessionFile = resolveSessionFile(process.argv[2]);
const outName = `pi-session-${basename(sessionFile, ".jsonl")}.html`;
const outPath = join(CHATS_DIR, outName);

mkdirSync(CHATS_DIR, { recursive: true });

const result = spawnSync("pi", ["--export", sessionFile, outPath], { stdio: "inherit" });
if (result.error) {
	console.error(`Failed to run pi --export: ${result.error.message}`);
	process.exit(1);
}
if (result.status !== 0) {
	process.exit(result.status ?? 1);
}
console.log(`Chat exported to ${outPath}`);
