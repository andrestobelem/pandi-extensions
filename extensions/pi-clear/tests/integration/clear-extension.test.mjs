#!/usr/bin/env node
/**
 * Durable behavioral integration test for extensions/pi-clear/index.ts.
 *
 * Pins the public /clear contract (a Claude-style alias for pi's native /new):
 * - registers a slash command named "clear" with a non-empty description
 * - the handler starts a fresh session via ctx.newSession() exactly once
 * - a cancelled new-session (an extension vetoed it) does not crash or error-notify
 * - a thrown newSession is reported as an error and never propagates
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

function makePi() {
	const commands = new Map();
	const pi = { registerCommand: (name, opts) => commands.set(name, opts) };
	return { pi, commands };
}

function makeCtx({ throwOnNew = false, cancelled = false } = {}) {
	const calls = { newSession: 0 };
	const notes = [];
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: { notify: (msg, type) => notes.push({ msg, type }) },
		newSession: async () => {
			calls.newSession += 1;
			if (throwOnNew) throw new Error("boom");
			return { cancelled };
		},
	};
	ctx._calls = calls;
	ctx._notes = notes;
	return ctx;
}

async function main() {
	const ext = await buildExtension({
		name: "pi-clear-integration",
		src: path.join(REPO_ROOT, "extensions", "pi-clear", "index.ts"),
		outName: "clear.mjs",
	});
	try {
		const clearExtension = await loadDefault(ext.url);

		const h = makePi();
		clearExtension(h.pi);
		const cmd = h.commands.get("clear");
		check("/clear command registered", !!cmd);
		check("/clear has a description", typeof cmd?.description === "string" && cmd.description.length > 0);

		const ctx = makeCtx();
		await cmd.handler("", ctx);
		check("/clear calls ctx.newSession() once", ctx._calls.newSession === 1, String(ctx._calls.newSession));
		check(
			"/clear does not error-notify on success",
			!ctx._notes.some((n) => n.type === "error"),
			JSON.stringify(ctx._notes),
		);

		// Cancelled (e.g. an extension vetoed the new session): no crash, no error note.
		const ctxCancel = makeCtx({ cancelled: true });
		let threwCancel = false;
		try {
			await cmd.handler("", ctxCancel);
		} catch {
			threwCancel = true;
		}
		check("/clear does not crash when the new session is cancelled", !threwCancel);
		check(
			"/clear does not error-notify on a cancelled new session",
			!ctxCancel._notes.some((n) => n.type === "error"),
			JSON.stringify(ctxCancel._notes),
		);

		// newSession throws: reported as an error, never propagates.
		const ctxThrow = makeCtx({ throwOnNew: true });
		let threw = false;
		try {
			await cmd.handler("", ctxThrow);
		} catch {
			threw = true;
		}
		check("/clear does not crash when newSession throws", !threw);
		check(
			"/clear reports a newSession failure as an error",
			ctxThrow._notes.some((n) => n.type === "error" && /clear/i.test(n.msg)),
			JSON.stringify(ctxThrow._notes),
		);
	} finally {
		await fs.rm(ext.outDir, { recursive: true, force: true });
	}

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log("Failures:");
		for (const failure of counts.failures) console.log(`- ${failure}`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(2);
});
