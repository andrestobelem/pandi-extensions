#!/usr/bin/env node
/**
 * Public extension contract for pandi-session.
 *
 * The extension owns /sessions, starts/stops its own heartbeat, and opens a
 * standalone TUI dashboard without coupling to the workflow extension.
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

function makeCtx(cwd, { mode = "tui", withSelect = false, selectResult } = {}) {
	const notes = [];
	const selectCalls = [];
	let customCalls = 0;
	const ui = {
		theme: { fg: (_c, value) => value, bg: (_c, value) => value, bold: (value) => value },
		notify: (msg, type) => notes.push({ msg, type }),
		confirm: async () => true,
		custom: async (factory) => {
			customCalls += 1;
			const tui = { terminal: { rows: 30, columns: 100 }, requestRender: () => {} };
			factory(tui, { fg: (_c, value) => value, bg: (_c, value) => value, bold: (value) => value }, {}, () => {});
			return null;
		},
	};
	if (withSelect) {
		ui.select = async (title, items) => {
			selectCalls.push({ title, items });
			return selectResult;
		};
	}
	return {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		cwd,
		isProjectTrusted: () => true,
		isIdle: () => true,
		ui,
		sessionManager: {
			getSessionId: () => "current-session-id",
			getSessionFile: () => path.join(cwd, ".pi", "sessions", "current.jsonl"),
			getSessionName: () => "Current session",
		},
		get _notes() {
			return notes;
		},
		get _selectCalls() {
			return selectCalls;
		},
		get _customCalls() {
			return customCalls;
		},
	};
}

async function writeJson(file, value) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, JSON.stringify(value), "utf8");
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
		const forbiddenRuntimeImport =
			source.includes("../pandi-" + "dynamic-" + "workflows") || source.includes("dynamic_" + "workflow");
		check("index has no workflow-extension runtime import", !forbiddenRuntimeImport, source);

		const ext = await loadDefault(url);
		const { pi, commands, handlers } = makePi();
		ext(pi);

		check("/session is not registered because Pi already owns it", !commands.has("session"));
		check("/sessions command registered", commands.has("sessions"));
		check("session_start handler registered", (handlers.get("session_start") ?? []).length === 1);
		check("session_shutdown handler registered", (handlers.get("session_shutdown") ?? []).length === 1);

		const ctx = makeCtx(project);
		for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
		await commands.get("sessions").handler("", ctx);
		check(
			"/sessions without ui.select keeps standalone TUI dashboard fallback",
			ctx._customCalls === 1,
			String(ctx._customCalls),
		);

		const menuCtx = makeCtx(project, {
			withSelect: true,
			selectResult: "dashboard — abrir el dashboard de sesiones",
		});
		await commands.get("sessions").handler("", menuCtx);
		check(
			"bare /sessions + UI opens the selector once",
			menuCtx._selectCalls.length === 1,
			String(menuCtx._selectCalls.length),
		);
		const items = menuCtx._selectCalls[0]?.items ?? [];
		const has = (token) => items.some((item) => String(item).startsWith(token));
		check(
			"/sessions selector offers dashboard/list/cleanup",
			["dashboard", "list", "cleanup"].every(has),
			JSON.stringify(items),
		);
		check(
			"selecting dashboard opens standalone TUI dashboard",
			menuCtx._customCalls === 1,
			String(menuCtx._customCalls),
		);

		const explicitCtx = makeCtx(project, {
			withSelect: true,
			selectResult: "cleanup — limpiar registros stale seguros",
		});
		const explicitStreams = await captureConsole(() => commands.get("sessions").handler("list", explicitCtx));
		check(
			"explicit /sessions list bypasses selector",
			explicitCtx._selectCalls.length === 0,
			String(explicitCtx._selectCalls.length),
		);
		check(
			"/sessions list works with UI selector available",
			explicitStreams.out.join("\n").includes("Pandi sessions"),
			JSON.stringify(explicitStreams),
		);

		const cancelCtx = makeCtx(project, { withSelect: true, selectResult: undefined });
		await commands.get("sessions").handler("", cancelCtx);
		check(
			"cancelled /sessions selector does not open dashboard",
			cancelCtx._customCalls === 0,
			String(cancelCtx._customCalls),
		);
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);

		const printCtx = makeCtx(project, { mode: "print" });
		const streams = await captureConsole(() => commands.get("sessions").handler("list", printCtx));
		check(
			"/sessions list works headless",
			streams.out.join("\n").includes("Pandi sessions"),
			JSON.stringify(streams),
		);
		check("headless list does not open custom TUI", printCtx._customCalls === 0, String(printCtx._customCalls));

		const deadFile = path.join(project, ".pi", "pandi-session", "live", "dead.json");
		await writeJson(deadFile, {
			id: "dead",
			pid: 99999999,
			mode: "tui",
			cwd: project,
			startedAt: "2020-01-01T00:00:00.000Z",
			updatedAt: "2020-01-01T00:00:00.000Z",
		});
		const cleanupPreview = await captureConsole(() =>
			commands.get("sessions").handler("cleanup --dry-run", printCtx),
		);
		check(
			"/sessions cleanup --dry-run lists delete candidate with reason",
			cleanupPreview.out.join("\n").includes("delete") && cleanupPreview.out.join("\n").includes("pid exited"),
			JSON.stringify(cleanupPreview),
		);
		check(
			"/sessions cleanup --dry-run keeps the candidate file",
			await fs.stat(deadFile).then(
				() => true,
				() => false,
			),
		);
		const unsafeCleanup = await captureConsole(() => commands.get("sessions").handler("cleanup", printCtx));
		check(
			"headless /sessions cleanup without --yes refuses destructive cleanup",
			unsafeCleanup.err.join("\n").includes("--yes"),
			JSON.stringify(unsafeCleanup),
		);
		check(
			"refused headless cleanup keeps candidate file",
			await fs.stat(deadFile).then(
				() => true,
				() => false,
			),
		);
		const cleanupYes = await captureConsole(() => commands.get("sessions").handler("cleanup --yes", printCtx));
		check(
			"/sessions cleanup --yes removes stale candidate",
			cleanupYes.out.join("\n").includes("Removed 1") &&
				!(await fs.stat(deadFile).then(
					() => true,
					() => false,
				)),
			JSON.stringify(cleanupYes),
		);
		const cleanupAgain = await captureConsole(() => commands.get("sessions").handler("cleanup --yes", printCtx));
		check(
			"/sessions cleanup --yes is idempotent after missing file",
			cleanupAgain.out.join("\n").includes("No stale Pandi session files"),
			JSON.stringify(cleanupAgain),
		);
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
