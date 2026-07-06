#!/usr/bin/env node
/**
 * Public extension contract for pandi-session.
 *
 * The extension owns /session and /sessions, starts/stops its own heartbeat, opens
 * a standalone TUI dashboard, and remains runtime-independent from
 * pandi-dynamic-workflows.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const { check, counts } = createChecker();

async function buildPandiSession() {
	return await buildExtension({
		name: "pandi-session-extension",
		src: path.join(REPO_ROOT, "extensions", "pandi-session", "index.ts"),
		outName: "pandi-session.mjs",
		stubs: { sdk: (dir) => sdkStub(dir), tui: true },
	});
}

function makePi() {
	const commands = new Map();
	const handlers = new Map();
	const pi = {
		registerCommand: (name, opts) => commands.set(name, opts),
		on: (event, handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
	};
	return { pi, commands, handlers };
}

function makeCtx(cwd, { mode = "tui" } = {}) {
	const notes = [];
	let customCalls = 0;
	return {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		cwd,
		isProjectTrusted: () => true,
		isIdle: () => true,
		ui: {
			theme: { fg: (_c, value) => value, bg: (_c, value) => value, bold: (value) => value },
			notify: (msg, type) => notes.push({ msg, type }),
			confirm: async () => true,
			custom: async (factory) => {
				customCalls += 1;
				const tui = { terminal: { rows: 30, columns: 100 }, requestRender: () => {} };
				factory(tui, { fg: (_c, value) => value, bg: (_c, value) => value, bold: (value) => value }, {}, () => {});
				return null;
			},
		},
		sessionManager: {
			getSessionId: () => "current-session-id",
			getSessionFile: () => path.join(cwd, ".pi", "sessions", "current.jsonl"),
			getSessionName: () => "Current session",
		},
		get _notes() {
			return notes;
		},
		get _customCalls() {
			return customCalls;
		},
	};
}

async function captureConsole(fn) {
	const out = [];
	const err = [];
	const log = console.log;
	const error = console.error;
	console.log = (...args) => out.push(args.join(" "));
	console.error = (...args) => err.push(args.join(" "));
	try {
		await fn();
	} finally {
		console.log = log;
		console.error = error;
	}
	return { out, err };
}

async function main() {
	const { outDir, url } = await buildPandiSession();
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pandi-session-extension-"));
	try {
		const source = await fs.readFile(path.join(REPO_ROOT, "extensions", "pandi-session", "index.ts"), "utf8");
		check(
			"index has no dynamic-workflows runtime import",
			!/pandi-dynamic-workflows|dynamic-workflows/.test(source),
			source,
		);

		const ext = await loadDefault(url);
		const { pi, commands, handlers } = makePi();
		ext(pi);

		check("/session command registered", commands.has("session"));
		check("/sessions command registered", commands.has("sessions"));
		check("session_start handler registered", (handlers.get("session_start") ?? []).length === 1);
		check("session_shutdown handler registered", (handlers.get("session_shutdown") ?? []).length === 1);

		const ctx = makeCtx(project);
		for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
		await commands.get("session").handler("", ctx);
		check("/session opens standalone TUI dashboard", ctx._customCalls === 1, String(ctx._customCalls));
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);

		const printCtx = makeCtx(project, { mode: "print" });
		const streams = await captureConsole(() => commands.get("sessions").handler("list", printCtx));
		check(
			"/sessions list works headless",
			streams.out.join("\n").includes("Pandi sessions"),
			JSON.stringify(streams),
		);
		check("headless list does not open custom TUI", printCtx._customCalls === 0, String(printCtx._customCalls));
	} finally {
		await fs.rm(project, { recursive: true, force: true }).catch(() => {});
		await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
	}

	if (counts.failed) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
