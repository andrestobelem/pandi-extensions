#!/usr/bin/env node
/**
 * Contrato de comportamiento del registro independiente de sesiones vivas de pandi-session.
 *
 * El registro pertenece a pandi-session:
 * escribe sus propios registros de heartbeat, recopila solo sesiones Pi TUI/RPC
 * locales del proyecto, clasifica filas obsoletas y limpia el heartbeat actual al apagarse.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, bundle, createChecker, makeBuildDir, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const CONTROLLED_FS_KEY = "__pandiSessionRegistryFsControl";
const { check, counts } = createChecker();

async function buildRegistry() {
	return await buildExtension({
		name: "pandi-session-registry",
		src: path.join(REPO_ROOT, "extensions", "pandi-session", "session-registry.ts"),
		outName: "session-registry.mjs",
		stubs: { sdk: (dir) => sdkStub(dir) },
	});
}

async function buildControlledRegistry() {
	const { outDir, aliases } = await makeBuildDir("pandi-session-registry-atomicity", {
		sdk: (dir) => sdkStub(dir),
	});
	const fsStub = path.join(outDir, "controlled-fs.mjs");
	await fs.writeFile(
		fsStub,
		`
import * as fs from "fs/promises";
export * from "fs/promises";

const control = () => globalThis[${JSON.stringify(CONTROLLED_FS_KEY)}];

export async function writeFile(file, data, ...args) {
	const current = control();
	const name = String(file);
	const controlled =
		current &&
		(name === current.target || (name.startsWith(current.target + ".") && name.endsWith(".tmp")));
	if (!controlled) return await fs.writeFile(file, data, ...args);
	const text = String(data);
	await fs.writeFile(file, text.slice(0, Math.max(1, Math.floor(text.length / 2))), ...args);
	current.started.resolve(name);
	await current.release.promise;
	try {
		if (current.fail) throw new Error("injected heartbeat write failure");
		return await fs.writeFile(file, data, ...args);
	} finally {
		current.finished.resolve();
	}
}
`,
		"utf8",
	);
	aliases["node:fs/promises"] = fsStub;
	const url = await bundle({
		src: path.join(REPO_ROOT, "extensions", "pandi-session", "session-registry.ts"),
		outDir,
		outName: "session-registry-controlled.mjs",
		aliases,
	});
	return { outDir, url };
}

function makeCtx(cwd, { mode = "tui", trusted = true, name = "Sesión actual" } = {}) {
	return {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		cwd,
		isProjectTrusted: () => trusted,
		isIdle: () => true,
		sessionManager: {
			getSessionId: () => `${name}-id`,
			getSessionFile: () => path.join(cwd, ".pi", "sessions", `${name}.jsonl`),
			getSessionName: () => name,
		},
	};
}

async function writeJson(file, value) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, JSON.stringify(value), "utf8");
}

function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function controlledWrite(target, { fail = false } = {}) {
	return {
		target,
		fail,
		started: deferred(),
		release: deferred(),
		finished: deferred(),
	};
}

async function tempSiblings(file) {
	const entries = await fs.readdir(path.dirname(file));
	const prefix = `${path.basename(file)}.`;
	return entries.filter((entry) => entry.startsWith(prefix) && entry.endsWith(".tmp"));
}

async function waitFor(predicate, tries = 100) {
	for (let attempt = 0; attempt < tries; attempt += 1) {
		if (await predicate()) return true;
		await new Promise((resolve) => setImmediate(resolve));
	}
	return false;
}

async function testAtomicHeartbeatWrites() {
	const { outDir, url } = await buildControlledRegistry();
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pandi-session-registry-atomicity-"));
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	let registry;
	let tickHeartbeat;
	let currentControl;
	try {
		globalThis.setInterval = (callback) => {
			tickHeartbeat = callback;
			return { unref() {} };
		};
		globalThis.clearInterval = () => {};
		registry = await import(url);
		const ctx = makeCtx(project);
		await registry.startPandiSessionHeartbeat({ reason: "atomicity" }, ctx);
		const initial = await registry.collectPandiSessions(ctx);
		const heartbeatFile = initial[0]?.file;
		if (!heartbeatFile || typeof tickHeartbeat !== "function") throw new Error("heartbeat fixture unavailable");
		const initialSnapshot = await fs.readFile(heartbeatFile, "utf8");

		currentControl = controlledWrite(heartbeatFile);
		globalThis[CONTROLLED_FS_KEY] = currentControl;
		tickHeartbeat();
		await currentControl.started.promise;
		const visibleDuringWrite = await fs.readFile(heartbeatFile, "utf8");
		check(
			"una escritura pausada mantiene visible el snapshot completo anterior",
			visibleDuringWrite === initialSnapshot,
			visibleDuringWrite,
		);
		currentControl.release.resolve();
		await currentControl.finished.promise;
		await waitFor(async () => (await tempSiblings(heartbeatFile)).length === 0);
		await new Promise((resolve) => setImmediate(resolve));
		const committedSnapshot = await fs.readFile(heartbeatFile, "utf8");
		check(
			"la escritura completada publica JSON íntegro",
			typeof JSON.parse(committedSnapshot).updatedAt === "string",
			committedSnapshot,
		);

		currentControl = controlledWrite(heartbeatFile, { fail: true });
		globalThis[CONTROLLED_FS_KEY] = currentControl;
		tickHeartbeat();
		await currentControl.started.promise;
		currentControl.release.resolve();
		await currentControl.finished.promise;
		const failedTempCleaned = await waitFor(async () => (await tempSiblings(heartbeatFile)).length === 0);
		await new Promise((resolve) => setImmediate(resolve));
		const afterFailedWrite = await fs.readFile(heartbeatFile, "utf8");
		check(
			"un write fallido preserva el último snapshot completo",
			afterFailedWrite === committedSnapshot,
			afterFailedWrite,
		);
		check(
			"un write fallido limpia el temp sibling",
			failedTempCleaned,
			JSON.stringify(await tempSiblings(heartbeatFile)),
		);

		currentControl = controlledWrite(heartbeatFile);
		globalThis[CONTROLLED_FS_KEY] = currentControl;
		tickHeartbeat();
		await currentControl.started.promise;
		let stopped = false;
		const stopping = registry.stopPandiSessionHeartbeat().then(() => {
			stopped = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		check("stop espera una escritura de filesystem in-flight", stopped === false);
		currentControl.release.resolve();
		await stopping;
		check(
			"stop no permite resurrección ni deja temp siblings",
			(await registry.collectPandiSessions(ctx)).length === 0 && (await tempSiblings(heartbeatFile)).length === 0,
		);
	} finally {
		currentControl?.release.resolve();
		delete globalThis[CONTROLLED_FS_KEY];
		await registry?.stopPandiSessionHeartbeat?.();
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
		await fs.rm(project, { recursive: true, force: true }).catch(() => {});
		await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
	}
}

async function main() {
	const { outDir, url } = await buildRegistry();
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pandi-session-registry-"));
	try {
		const registry = await import(url);
		const ctx = makeCtx(project);

		await registry.startPandiSessionHeartbeat({ reason: "startup" }, ctx);
		const live = await registry.collectPandiSessions(ctx);
		check("el heartbeat crea una sola sesión viva actual", live.length === 1, JSON.stringify(live));
		check("el heartbeat actual se marca como current", live[0]?.current === true, JSON.stringify(live[0]));
		check("el heartbeat actual se marca como live", live[0]?.live === true, JSON.stringify(live[0]));
		check(
			"el heartbeat actual registra metadata de la sesión",
			live[0]?.sessionName === "Sesión actual",
			JSON.stringify(live[0]),
		);

		await registry.stopPandiSessionHeartbeat();
		const afterStop = await registry.collectPandiSessions(ctx);
		check("stop elimina el registro del heartbeat actual", afterStop.length === 0, JSON.stringify(afterStop));

		const originalSetInterval = globalThis.setInterval;
		const originalClearInterval = globalThis.clearInterval;
		const writeStarted = deferred();
		const releaseWrite = deferred();
		let tickHeartbeat;
		let stopped = false;
		let firstGeneration;
		try {
			globalThis.setInterval = (callback) => {
				tickHeartbeat = callback;
				return { unref() {} };
			};
			globalThis.clearInterval = () => {};

			await registry.startPandiSessionHeartbeat({ reason: "race" }, ctx);
			registry.setPandiSessionHeartbeatWriteHookForTests(async (generation) => {
				firstGeneration = generation;
				writeStarted.resolve();
				await releaseWrite.promise;
			});
			tickHeartbeat();
			await writeStarted.promise;

			const stopping = registry.stopPandiSessionHeartbeat().then(() => {
				stopped = true;
			});
			await new Promise((resolve) => setImmediate(resolve));
			check("stop espera el heartbeat in-flight antes de borrar", stopped === false);

			releaseWrite.resolve();
			await stopping;
			const afterRacingStop = await registry.collectPandiSessions(ctx);
			check(
				"un heartbeat pausado no recrea el archivo después de stop",
				afterRacingStop.length === 0,
				JSON.stringify(afterRacingStop),
			);

			let restartedGeneration;
			registry.setPandiSessionHeartbeatWriteHookForTests(async (generation) => {
				restartedGeneration = generation;
			});
			await registry.startPandiSessionHeartbeat({ reason: "restart" }, ctx);
			check(
				"start posterior usa una generación nueva",
				Number.isInteger(firstGeneration) &&
					Number.isInteger(restartedGeneration) &&
					restartedGeneration > firstGeneration,
				JSON.stringify({ firstGeneration, restartedGeneration }),
			);
			await registry.stopPandiSessionHeartbeat();
		} finally {
			registry.setPandiSessionHeartbeatWriteHookForTests?.();
			globalThis.setInterval = originalSetInterval;
			globalThis.clearInterval = originalClearInterval;
		}

		await registry.startPandiSessionHeartbeat({ reason: "startup" }, makeCtx(project, { mode: "print" }));
		const printSessions = await registry.collectPandiSessions(ctx);
		check(
			"las sesiones print/json no escriben heartbeats vivos",
			printSessions.length === 0,
			JSON.stringify(printSessions),
		);

		const staleRoot = path.join(project, ".pi", "pandi-session", "live");
		const staleFile = path.join(staleRoot, "stale.json");
		await writeJson(staleFile, {
			id: "stale",
			pid: 99999999,
			mode: "tui",
			cwd: project,
			startedAt: "2020-01-01T00:00:00.000Z",
			updatedAt: "2020-01-01T00:00:00.000Z",
			sessionId: "stale-id",
			sessionFile: path.join(project, ".pi", "sessions", "stale.jsonl"),
			sessionName: "Sesión obsoleta",
		});
		await registry.startPandiSessionHeartbeat({ reason: "startup" }, ctx);
		const mixed = await registry.collectPandiSessions(ctx);
		check(
			"la sesión current/live se ordena antes que las filas stale",
			mixed[0]?.current === true && mixed[1]?.id === "stale",
			JSON.stringify(mixed),
		);
		check(
			"la fila stale explica el PID muerto",
			mixed[1]?.live === false && /PID finalizado/.test(mixed[1]?.staleReason ?? ""),
			JSON.stringify(mixed[1]),
		);

		const formatted = registry.formatPandiSessionList(mixed);
		check("el formateador de texto identifica Sesiones Pandi", formatted.includes("Sesiones Pandi (2)"), formatted);
		check(
			"el formateador de texto incluye la metadata seleccionada",
			formatted.includes("Sesión obsoleta") && formatted.includes("Sesión actual"),
			formatted,
		);

		const now = Date.parse("2026-07-01T00:00:00Z");
		const iso = (msAgo) => new Date(now - msAgo).toISOString();
		const cleanupEntries = [
			{
				file: "dead.json",
				record: { id: "dead", pid: 999, mode: "tui", cwd: project, startedAt: iso(1000), updatedAt: iso(1000) },
			},
			{
				file: "live.json",
				record: { id: "live", pid: 100, mode: "tui", cwd: project, startedAt: iso(1000), updatedAt: iso(1000) },
			},
			{
				file: "current.json",
				record: { id: "current", pid: 999, mode: "tui", cwd: project, startedAt: iso(1000), updatedAt: iso(1000) },
			},
			{
				file: "heartbeat-stale.json",
				record: {
					id: "heartbeat-stale",
					pid: 100,
					mode: "tui",
					cwd: project,
					startedAt: iso(registry.PANDI_SESSION_STALE_MS + 1000),
					updatedAt: iso(registry.PANDI_SESSION_STALE_MS + 1000),
				},
			},
			{ file: "bad.json", record: { pid: "nope" } },
		];
		const cleanup = registry.classifyPandiSessionFilesForCleanup(cleanupEntries, {
			now,
			isPidAlive: (pid) => pid !== 999,
			currentId: "current",
		});
		const actionByFile = Object.fromEntries(cleanup.map((item) => [item.file, item]));
		check(
			"el inventario de limpieza marca el PID muerto para delete",
			actionByFile["dead.json"]?.action === "delete",
		);
		check("el inventario de limpieza conserva la sesión live", actionByFile["live.json"]?.action === "keep");
		check(
			"el inventario de limpieza conserva la sesión current",
			actionByFile["current.json"]?.reason === "sesión actual",
		);
		check(
			"el inventario de limpieza conserva heartbeat-stale por defecto",
			actionByFile["heartbeat-stale.json"]?.action === "keep" &&
				/heartbeat obsoleto/.test(actionByFile["heartbeat-stale.json"]?.reason ?? ""),
			JSON.stringify(actionByFile["heartbeat-stale.json"]),
		);
		check("el inventario de limpieza conserva registros malformados", actionByFile["bad.json"]?.action === "keep");
		const cleanupAllStale = registry.classifyPandiSessionFilesForCleanup(cleanupEntries, {
			now,
			isPidAlive: (pid) => pid !== 999,
			currentId: "current",
			includeHeartbeatStale: true,
		});
		check(
			"el inventario de limpieza puede borrar heartbeat-stale cuando se solicita",
			cleanupAllStale.find((item) => item.file === "heartbeat-stale.json")?.action === "delete",
			JSON.stringify(cleanupAllStale),
		);

		const preview = await registry.prunePandiSessionFiles(ctx, { dryRun: true });
		check(
			"el dry-run informa el inventario de limpieza por archivo",
			Array.isArray(preview.items),
			JSON.stringify(preview),
		);
		check(
			"el dry-run no borra el archivo stale del heartbeat",
			await fs.stat(staleFile).then(
				() => true,
				() => false,
			),
		);
		const pruned = await registry.prunePandiSessionFiles(ctx);
		check(
			"la limpieza borra el archivo stale con PID muerto",
			pruned.removed.includes(staleFile),
			JSON.stringify(pruned),
		);
		const prunedAgain = await registry.prunePandiSessionFiles(ctx);
		check(
			"la limpieza es idempotente después de archivos faltantes",
			prunedAgain.removed.length === 0,
			JSON.stringify(prunedAgain),
		);
	} finally {
		try {
			const registry = await import(`${url}?cleanup`);
			await registry.stopPandiSessionHeartbeat?.();
		} catch {}
		await fs.rm(project, { recursive: true, force: true }).catch(() => {});
		await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
	}

	await testAtomicHeartbeatWrites();

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
