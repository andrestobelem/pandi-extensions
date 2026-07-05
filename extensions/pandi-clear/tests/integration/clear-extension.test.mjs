#!/usr/bin/env node
/**
 * Durable behavioral integration test for extensions/pandi-clear/index.ts.
 *
 * Pins the public /clear contract (a Claude-style alias for pi's native /new):
 * - registers a slash command named "clear" with a non-empty description
 * - the handler starts a fresh session via ctx.newSession() exactly once
 * - a cancelled new-session (an extension vetoed it) does not crash or error-notify
 * - a thrown newSession is reported as an error and never propagates
 * - success is STRICTLY silent (no notifications at all), in tui and in print mode
 * - print mode (mode="print", hasUI=false): a failure goes to stderr, never stdout,
 *   never ui.notify; note the info→stdout arm of notify() is unreachable through
 *   /clear's public contract (its only notify call site is type "error")
 * - a NON-Error throw is stringified via the String(error) arm (issue #12)
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

function makeCtx({ throwOnNew = false, throwValue, cancelled = false, mode = "tui" } = {}) {
	const calls = { newSession: 0 };
	const notes = [];
	const ctx = {
		mode,
		hasUI: mode !== "print",
		ui: { notify: (msg, type) => notes.push({ msg, type }) },
		newSession: async () => {
			calls.newSession += 1;
			if (throwOnNew) throw throwValue !== undefined ? throwValue : new Error("boom");
			return { cancelled };
		},
	};
	ctx._calls = calls;
	ctx._notes = notes;
	return ctx;
}

/** Run `fn` with console.log/console.error captured; returns { out, err }. */
async function withCapturedConsole(fn) {
	const out = [];
	const err = [];
	const savedLog = console.log;
	const savedError = console.error;
	console.log = (...a) => out.push(a.join(" "));
	console.error = (...a) => err.push(a.join(" "));
	try {
		await fn();
	} finally {
		console.log = savedLog;
		console.error = savedError;
	}
	return { out, err };
}

async function main() {
	const ext = await buildExtension({
		name: "pi-clear-integration",
		src: path.join(REPO_ROOT, "extensions", "pandi-clear", "index.ts"),
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
			"/clear is STRICTLY silent on success (no notifications at all)",
			ctx._notes.length === 0,
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

		// A NON-Error throw exercises the String(error) arm of the message formatting.
		const ctxThrowRaw = makeCtx({ throwOnNew: true, throwValue: "nope-not-an-error" });
		await cmd.handler("", ctxThrowRaw);
		check(
			"/clear stringifies a non-Error throw into the error note",
			ctxThrowRaw._notes.some((n) => n.type === "error" && /nope-not-an-error/.test(n.msg)),
			JSON.stringify(ctxThrowRaw._notes),
		);

		// Print mode (mode="print", hasUI=false): failures go to STDERR — never stdout,
		// never ui.notify. This pins the print branch of notify().
		const ctxPrintFail = makeCtx({ throwOnNew: true, mode: "print" });
		const failStreams = await withCapturedConsole(() => cmd.handler("", ctxPrintFail));
		check(
			"print mode: failure reported on stderr",
			failStreams.err.some((l) => /clear falló/.test(l) && /boom/.test(l)),
			JSON.stringify(failStreams),
		);
		check(
			"print mode: nothing on stdout for a failure",
			failStreams.out.length === 0,
			JSON.stringify(failStreams.out),
		);
		check("print mode: ui.notify never used", ctxPrintFail._notes.length === 0, JSON.stringify(ctxPrintFail._notes));

		// Print mode success: strictly silent on BOTH channels.
		const ctxPrintOk = makeCtx({ mode: "print" });
		const okStreams = await withCapturedConsole(() => cmd.handler("", ctxPrintOk));
		check(
			"print mode: success is silent on stdout and stderr",
			okStreams.out.length === 0 && okStreams.err.length === 0,
			JSON.stringify(okStreams),
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
