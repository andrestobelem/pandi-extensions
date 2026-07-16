#!/usr/bin/env node
/**
 * Contrato público de la extensión pandi-session.
 *
 * La extensión es dueña de /sessions, inicia/detiene su propio heartbeat y abre un
 * dashboard TUI independiente sin acoplarse a la extensión de workflows.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, loadModule, sdkStub } from "../../../shared/test/harness.mjs";

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

function makeCtx(cwd, { mode = "tui", withSelect = false, selectResult, withConfirm = true, onRender } = {}) {
	const notes = [];
	const selectCalls = [];
	let customCalls = 0;
	const ui = {
		theme: { fg: (_c, value) => value, bg: (_c, value) => value, bold: (value) => value },
		notify: (msg, type) => notes.push({ msg, type }),
		custom: async (factory) => {
			customCalls += 1;
			const tui = { terminal: { rows: 30, columns: 100 }, requestRender: () => onRender?.() };
			factory(tui, { fg: (_c, value) => value, bg: (_c, value) => value, bold: (value) => value }, {}, () => {});
			return null;
		},
	};
	if (withConfirm) ui.confirm = async () => true;
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
			getSessionName: () => "Sesión actual",
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

async function dashboardDoesNotRenderAfterClose(url, check) {
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	let refresh;
	let cleared = 0;
	let renders = 0;
	globalThis.setInterval = (callback) => {
		refresh = callback;
		return {};
	};
	globalThis.clearInterval = () => {
		cleared += 1;
	};
	try {
		const ext = await loadDefault(url);
		const { pi, commands } = makePi();
		ext(pi);
		const project = await fs.mkdtemp(path.join(os.tmpdir(), "pandi-session-dashboard-close-"));
		try {
			await commands.get("sessions").handler("", makeCtx(project, { onRender: () => renders++ }));
			await refresh();
			await new Promise((resolve) => setTimeout(resolve, 20));
			check(
				"el refresh en vuelo no renderiza después de cerrar el dashboard",
				cleared === 1 && renders === 0,
				JSON.stringify({ cleared, renders }),
			);
		} finally {
			await fs.rm(project, { recursive: true, force: true });
		}
	} finally {
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
	}
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
		await dashboardDoesNotRenderAfterClose(url, check);

		const source = await fs.readFile(path.join(REPO_ROOT, "extensions", "pandi-session", "index.ts"), "utf8");
		const forbiddenRuntimeImport =
			source.includes("../pandi-" + "dynamic-" + "workflows") || source.includes("dynamic_" + "workflow");
		check("el índice no importa en runtime la extensión de workflows", !forbiddenRuntimeImport, source);

		const mod = await loadModule(url);
		const ext = await loadDefault(url);
		const { pi, commands, handlers } = makePi();
		ext(pi);

		check("/session no se registra porque Pi ya lo posee", !commands.has("session"));
		check("el comando /sessions se registra", commands.has("sessions"));
		check("se registra el handler session_start", (handlers.get("session_start") ?? []).length === 1);
		check("se registra el handler session_shutdown", (handlers.get("session_shutdown") ?? []).length === 1);

		const ctx = makeCtx(project);
		for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
		await commands.get("sessions").handler("", ctx);
		check(
			"/sessions sin ui.select conserva el fallback al dashboard TUI independiente",
			ctx._customCalls === 1,
			String(ctx._customCalls),
		);

		const menuCtx = makeCtx(project, {
			withSelect: true,
			selectResult: "dashboard — abrir el panel de sesiones",
		});
		await commands.get("sessions").handler("", menuCtx);
		check(
			"/sessions vacío + UI abre el selector una sola vez",
			menuCtx._selectCalls.length === 1,
			String(menuCtx._selectCalls.length),
		);
		const items = menuCtx._selectCalls[0]?.items ?? [];
		check(
			"el selector de /sessions ofrece exactamente las etiquetas de acción exportadas",
			JSON.stringify(items) === JSON.stringify(mod.PANDI_SESSION_SELECT_ITEMS),
			JSON.stringify(items),
		);
		check(
			"seleccionar dashboard abre el dashboard TUI independiente",
			menuCtx._customCalls === 1,
			String(menuCtx._customCalls),
		);

		const explicitCtx = makeCtx(project, {
			withSelect: true,
			selectResult: "cleanup — limpiar registros stale seguros",
		});
		const explicitStreams = await captureConsole(() => commands.get("sessions").handler("list", explicitCtx));
		check(
			"/sessions list explícito omite el selector",
			explicitCtx._selectCalls.length === 0,
			String(explicitCtx._selectCalls.length),
		);
		check(
			"/sessions list funciona con el selector de UI disponible",
			explicitStreams.out.join("\n").includes("Sesiones Pandi"),
			JSON.stringify(explicitStreams),
		);

		const cancelCtx = makeCtx(project, { withSelect: true, selectResult: undefined });
		await commands.get("sessions").handler("", cancelCtx);
		check(
			"un selector /sessions cancelado no abre el dashboard",
			cancelCtx._customCalls === 0,
			String(cancelCtx._customCalls),
		);
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);

		const printCtx = makeCtx(project, { mode: "print" });
		const streams = await captureConsole(() => commands.get("sessions").handler("list", printCtx));
		check(
			"/sessions list funciona sin UI",
			streams.out.join("\n").includes("Sesiones Pandi"),
			JSON.stringify(streams),
		);
		check("la lista sin UI no abre un TUI personalizado", printCtx._customCalls === 0, String(printCtx._customCalls));

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
			"/sessions cleanup --dry-run lista la candidata delete con su razón",
			cleanupPreview.out.join("\n").includes("delete") && cleanupPreview.out.join("\n").includes("PID finalizado"),
			JSON.stringify(cleanupPreview),
		);
		check(
			"/sessions cleanup --dry-run conserva el archivo candidato",
			await fs.stat(deadFile).then(
				() => true,
				() => false,
			),
		);
		const unsafeCleanup = await captureConsole(() => commands.get("sessions").handler("cleanup", printCtx));
		check(
			"/sessions cleanup sin UI y sin --yes rechaza la limpieza destructiva",
			unsafeCleanup.err.join("\n").includes("--yes"),
			JSON.stringify(unsafeCleanup),
		);
		check(
			"la limpieza rechazada sin UI conserva el archivo candidato",
			await fs.stat(deadFile).then(
				() => true,
				() => false,
			),
		);
		const uiNoConfirmFile = path.join(project, ".pi", "pandi-session", "live", "ui-no-confirm.json");
		await writeJson(uiNoConfirmFile, {
			id: "ui-no-confirm",
			pid: 99999998,
			mode: "tui",
			cwd: project,
			startedAt: "2020-01-01T00:00:00.000Z",
			updatedAt: "2020-01-01T00:00:00.000Z",
		});
		const uiNoConfirmCtx = makeCtx(project, { withConfirm: false });
		await commands.get("sessions").handler("cleanup", uiNoConfirmCtx);
		check(
			"la UI sin confirmación rechaza la limpieza destructiva salvo --yes",
			/--yes|--dry-run/.test(uiNoConfirmCtx._notes.at(-1)?.msg || "") &&
				(await fs.stat(uiNoConfirmFile).then(
					() => true,
					() => false,
				)),
			JSON.stringify(uiNoConfirmCtx._notes),
		);

		const cleanupYes = await captureConsole(() => commands.get("sessions").handler("cleanup --yes", printCtx));
		check(
			"/sessions cleanup --yes elimina las candidatas obsoletas",
			cleanupYes.out.join("\n").includes("Se eliminaron 2") &&
				!(await fs.stat(deadFile).then(
					() => true,
					() => false,
				)) &&
				!(await fs.stat(uiNoConfirmFile).then(
					() => true,
					() => false,
				)),
			JSON.stringify(cleanupYes),
		);
		const cleanupAgain = await captureConsole(() => commands.get("sessions").handler("cleanup --yes", printCtx));
		check(
			"/sessions cleanup --yes es idempotente después de un archivo faltante",
			cleanupAgain.out.join("\n").includes("No hay archivos de sesión Pandi obsoletos"),
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
