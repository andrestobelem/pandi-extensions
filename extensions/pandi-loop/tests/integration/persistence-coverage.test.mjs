/**
 * Suite de integración de caracterización para extensions/pandi-loop/persistence.ts.
 *
 * Por qué existe este archivo
 * --------------------
 * `npm test` solo hace TYPECHECK. persistence.ts posee el lado durable de la extensión loop:
 * append JSONL + sidecar atómico fire-and-forget, resolución dual-root, lectura/descubrimiento
 * de sidecars y resolución de conflictos por updatedAt (`newerState`). Un drift silencioso
 * perdería estado de recuperación; `tsc` no ve nada de eso.
 *
 * `snapshot` vive en state.ts y ya tiene cobertura en loop-state.test.mjs; acá no se re-testea.
 *
 * Ejecución:
 *   node extensions/pandi-loop/tests/integration/persistence-coverage.test.mjs
 */

import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildExtension,
	bundle,
	createChecker,
	loadModule,
	makeBuildDir,
	sdkStub,
} from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const STATE_FILE = "state.json";
const LOOP_DIR = "loops";
const CONFIG_DIR_NAME = ".pi";
const LOOP_STATE_TYPE = "loop-state";
const CONTROLLED_FS_KEY = "__pandiLoopPersistenceFsControl";

const { check, counts } = createChecker();

async function buildPersistence() {
	return await buildExtension({
		name: "pi-loop-persistence-integration",
		src: path.join(REPO_ROOT, "extensions", "pandi-loop", "persistence.ts"),
		outName: "persistence.mjs",
		stubs: { sdk: (dir) => sdkStub(dir) },
	});
}

async function buildControlledPersistence() {
	const { outDir, aliases } = await makeBuildDir("pi-loop-persistence-race", {
		sdk: (dir) => sdkStub(dir),
	});
	const fsStub = path.join(outDir, "controlled-fs.mjs");
	await fs.writeFile(
		fsStub,
		`
import * as fs from "fs/promises";

const labelsByTemp = new Map();
const control = () => globalThis[${JSON.stringify(CONTROLLED_FS_KEY)}];

export const mkdir = (...args) => fs.mkdir(...args);
export const readFile = (...args) => fs.readFile(...args);
export const readdir = (...args) => fs.readdir(...args);
export const rm = (...args) => fs.rm(...args);

export async function writeFile(file, data, ...args) {
	try {
		const state = JSON.parse(String(data));
		if (typeof state.lastReason === "string") labelsByTemp.set(String(file), state.lastReason);
	} catch {}
	return await fs.writeFile(file, data, ...args);
}

export async function rename(temp, file) {
	const label = labelsByTemp.get(String(temp));
	const current = control();
	if (label && current) {
		current.started.push(label);
		await current.gates.get(label)?.promise;
	}
	await fs.rename(temp, file);
	if (label && current) current.committed.push(label);
}
`,
		"utf8",
	);
	aliases["node:fs/promises"] = fsStub;
	const url = await bundle({
		src: path.join(REPO_ROOT, "extensions", "pandi-loop", "persistence.ts"),
		outDir,
		outName: "persistence-controlled.mjs",
		aliases,
	});
	return { outDir, url };
}

function agentDirFor(outDir) {
	return path.join(outDir, "agentdir");
}

function makePi() {
	const entries = [];
	return {
		pi: {
			appendEntry: (customType, data) => entries.push({ customType, data }),
		},
		entries,
	};
}

function makeLoop(overrides = {}) {
	return {
		loopId: "loop-sentinel-id",
		task: "task-sentinel",
		mode: "dynamic",
		intervalMs: undefined,
		iteration: 3,
		maxIterations: 25,
		maxWallClockMs: 6 * 60 * 60 * 1000,
		contextPercentCap: 90,
		startedAt: 1_700_000_000_000,
		nextFireAt: 1_700_000_060_000,
		lastReason: "reason-sentinel",
		status: "running",
		autonomous: false,
		ultracode: false,
		ownerSessionId: "session-sentinel",
		updatedAt: "2020-01-01T00:00:00.000Z",
		timer: setTimeout(() => {}, 100_000),
		controller: { abort() {} },
		rearmedThisTurn: true,
		autopilot: true,
		...overrides,
	};
}

function makeState(overrides = {}) {
	const loop = makeLoop(overrides);
	clearTimeout(loop.timer);
	const { timer: _timer, controller: _controller, rearmedThisTurn: _rearmed, autopilot: _autopilot, ...state } = loop;
	return state;
}

async function flush(predicate, tries = 2000) {
	for (let i = 0; i < tries; i++) {
		await new Promise((r) => setImmediate(r));
		if (predicate?.()) return true;
	}
	return predicate ? predicate() : true;
}

async function waitForNoTmpFiles(dir, tries = 2000) {
	let entries = [];
	for (let i = 0; i < tries; i++) {
		await new Promise((r) => setImmediate(r));
		entries = await fs.readdir(dir);
		if (!entries.some((f) => f.endsWith(".tmp"))) return entries;
	}
	return entries;
}

function deferred() {
	let release;
	const promise = new Promise((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

function persistAppendsAndStamps(mod) {
	const { pi, entries } = makePi();
	const ctx = { isProjectTrusted: () => true, cwd: os.tmpdir() };
	const loop = makeLoop({ updatedAt: "1999-01-01T00:00:00.000Z" });
	clearTimeout(loop.timer);
	const before = Date.now();
	const ret = mod.persist(pi, ctx, loop);
	check("persist() returns undefined (void)", ret === undefined, `ret=${String(ret)}`);
	check("persist() appends exactly one entry synchronously", entries.length === 1, `n=${entries.length}`);
	check(
		"persist() appends under the loop-state custom type",
		entries[0]?.customType === LOOP_STATE_TYPE,
		`type=${entries[0]?.customType}`,
	);
	const stamped = Date.parse(loop.updatedAt);
	check(
		"persist() re-stamps loop.updatedAt to now (fresh ISO timestamp)",
		Number.isFinite(stamped) && stamped >= before && loop.updatedAt !== "1999-01-01T00:00:00.000Z",
		`updatedAt=${loop.updatedAt}`,
	);
	check(
		"persist() appends the SNAPSHOT (no runtime fields), carrying the new updatedAt",
		entries[0]?.data?.updatedAt === loop.updatedAt &&
			!("timer" in (entries[0]?.data ?? {})) &&
			!("autopilot" in (entries[0]?.data ?? {})),
		`snapUpdatedAt=${entries[0]?.data?.updatedAt}`,
	);
}

async function persistReportsSidecarError(mod) {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loop-persist-fail-"));
	const fileAsCwd = path.join(tmp, "iam-a-file");
	await fs.writeFile(fileAsCwd, "not a dir");
	const { pi, entries } = makePi();
	const observedErrors = [];
	const ctx = {
		isProjectTrusted: () => true,
		cwd: fileAsCwd,
		mode: "tui",
		hasUI: true,
		ui: {
			notify: (message, type) => observedErrors.push({ message, type }),
		},
	};
	const loop = makeLoop();
	clearTimeout(loop.timer);
	const unhandledRejections = [];
	const onUnhandledRejection = (reason) => unhandledRejections.push(String(reason?.message ?? reason));
	process.on("unhandledRejection", onUnhandledRejection);
	let threw = false;
	try {
		mod.persist(pi, ctx, loop);
	} catch {
		threw = true;
	}
	check("persist() does not throw when the sidecar write will fail", !threw);
	check(
		"persist() still appended the JSONL entry despite sidecar failure",
		entries.length === 1,
		`n=${entries.length}`,
	);
	try {
		await flush(() => observedErrors.length > 0 || unhandledRejections.length > 0, 200);
	} finally {
		process.off("unhandledRejection", onUnhandledRejection);
	}
	check(
		"persist() sidecar failure is observable through the UI",
		observedErrors.length === 1 &&
			observedErrors[0]?.type === "error" &&
			/sidecar|persist/i.test(observedErrors[0]?.message ?? ""),
		JSON.stringify(observedErrors),
	);
	check(
		"persist() sidecar failure produces no unhandledRejection",
		unhandledRejections.length === 0,
		JSON.stringify(unhandledRejections),
	);
	await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

async function persistRejectsUnsafeLoopId(mod) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "loop-persist-unsafe-id-"));
	const { pi, entries } = makePi();
	const observedErrors = [];
	const ctx = {
		isProjectTrusted: () => true,
		cwd,
		mode: "tui",
		hasUI: true,
		ui: {
			notify: (message, type) => observedErrors.push({ message, type }),
		},
	};
	const loop = makeLoop({ loopId: "../../write-escape" });
	clearTimeout(loop.timer);

	mod.persist(pi, ctx, loop);
	await flush(() => observedErrors.length > 0);

	check("persist() rejects an unsafe loopId before appending JSONL", entries.length === 0, `n=${entries.length}`);
	check(
		"persist() reports the rejected unsafe loopId",
		observedErrors.length === 1 &&
			observedErrors[0]?.type === "error" &&
			/loopId|id/i.test(observedErrors[0]?.message),
		JSON.stringify(observedErrors),
	);
	check(
		"persist() never writes an unsafe loopId outside the canonical root",
		!existsSync(path.join(cwd, "write-escape", STATE_FILE)),
	);
	await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
}

async function sidecarKeepsLatestLogicalTransition(mod) {
	const scenarios = [
		{ name: "transition", latestStatus: "paused", latestNextFireAt: null },
		{ name: "stop", latestStatus: "stopped", latestNextFireAt: null },
		{ name: "shutdown", latestStatus: "stale", latestNextFireAt: 1_700_000_060_000 },
	];

	for (const scenario of scenarios) {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), `loop-persist-${scenario.name}-`));
		const firstLabel = `${scenario.name}-A-running`;
		const latestLabel = `${scenario.name}-B-${scenario.latestStatus}`;
		const firstGate = deferred();
		const latestGate = deferred();
		const control = {
			gates: new Map([
				[firstLabel, firstGate],
				[latestLabel, latestGate],
			]),
			started: [],
			committed: [],
		};
		globalThis[CONTROLLED_FS_KEY] = control;

		try {
			const { pi } = makePi();
			const ctx = { isProjectTrusted: () => true, cwd };
			const loop = makeLoop({
				loopId: `race-${scenario.name}`,
				status: "running",
				lastReason: firstLabel,
			});
			clearTimeout(loop.timer);

			mod.persist(pi, ctx, loop);
			await flush(() => control.started.includes(firstLabel));

			loop.status = scenario.latestStatus;
			loop.nextFireAt = scenario.latestNextFireAt;
			loop.lastReason = latestLabel;
			mod.persist(pi, ctx, loop);

			// Señalamos B antes que A. Sin serialización ambas renames arrancan y B
			// llega durable primero; luego la rename tardía de A puede pisarla.
			latestGate.release();
			const latestStartedBeforeFirstReleased = await flush(() => control.started.includes(latestLabel), 100);
			if (latestStartedBeforeFirstReleased) {
				await flush(() => control.committed.includes(latestLabel));
			}
			firstGate.release();
			await flush(() => control.committed.includes(firstLabel) && control.committed.includes(latestLabel));

			const file = path.join(cwd, CONFIG_DIR_NAME, LOOP_DIR, loop.loopId, STATE_FILE);
			const durable = JSON.parse(await fs.readFile(file, "utf8"));
			check(
				`${scenario.name}: sidecar keeps B after requesting B completion before A`,
				durable.status === scenario.latestStatus && durable.lastReason === latestLabel,
				JSON.stringify({ durable, started: control.started, committed: control.committed }),
			);
		} finally {
			firstGate.release();
			latestGate.release();
			delete globalThis[CONTROLLED_FS_KEY];
			await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
		}
	}
}

async function sidecarAtomicWriteTrustedRoot(mod) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "loop-trusted-"));
	const { pi } = makePi();
	const ctx = { isProjectTrusted: () => true, cwd };
	const loop = makeLoop({ loopId: "trusted-loop-1" });
	clearTimeout(loop.timer);
	mod.persist(pi, ctx, loop);
	const dir = path.join(cwd, CONFIG_DIR_NAME, LOOP_DIR, "trusted-loop-1");
	const file = path.join(dir, STATE_FILE);
	await flush(() => existsSync(file));
	check("writeSidecar() trusted root lands at <cwd>/.pi/loops/<id>/state.json", existsSync(file), file);

	if (existsSync(file)) {
		const raw = await fs.readFile(file, "utf8");
		const parsed = JSON.parse(raw);
		check(
			"writeSidecar() state.json parses to the snapshot",
			parsed.loopId === "trusted-loop-1",
			`id=${parsed.loopId}`,
		);
		check(
			"writeSidecar() writes pretty-printed JSON (2-space indent) with a trailing newline",
			raw.endsWith("\n") && raw.includes('\n  "loopId"'),
			JSON.stringify(raw.slice(0, 24)),
		);
		const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"));
		check(
			"writeSidecar() leaves no orphaned *.tmp file after a successful rename",
			leftovers.length === 0,
			leftovers.join(","),
		);
	}
	await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
}

async function sidecarTempCleanupOnRenameFailure(mod) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "loop-rename-fail-"));
	const dir = path.join(cwd, CONFIG_DIR_NAME, LOOP_DIR, "rename-fail-loop");
	await fs.mkdir(dir, { recursive: true });
	const stateAsDir = path.join(dir, STATE_FILE);
	await fs.mkdir(stateAsDir, { recursive: true });
	await fs.writeFile(path.join(stateAsDir, "blocker"), "x");

	const { pi, entries } = makePi();
	const ctx = { isProjectTrusted: () => true, cwd };
	const loop = makeLoop({ loopId: "rename-fail-loop" });
	clearTimeout(loop.timer);
	mod.persist(pi, ctx, loop);
	check("persist() still appended despite the doomed rename", entries.length === 1, `n=${entries.length}`);
	const entriesInDir = await waitForNoTmpFiles(dir);
	const tmpLeftovers = entriesInDir.filter((f) => f.endsWith(".tmp"));
	check(
		"writeSidecar() removes the temp file when rename fails (no orphaned *.tmp)",
		tmpLeftovers.length === 0,
		`leftovers=[${tmpLeftovers.join(",")}]`,
	);
	check(
		"writeSidecar() does NOT clobber the existing state.json directory on failure",
		existsSync(stateAsDir),
		stateAsDir,
	);
	await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
}

async function sidecarUntrustedRootUsesSha1Hash(mod, outDir) {
	const projectPath = "/some/path";
	const expectedHash = crypto.createHash("sha1").update(projectPath).digest("hex").slice(0, 12);
	const { pi } = makePi();
	const ctx = { isProjectTrusted: () => false, cwd: projectPath };
	const loop = makeLoop({ loopId: "untrusted-loop-1" });
	clearTimeout(loop.timer);
	mod.persist(pi, ctx, loop);
	const expectedFile = path.join(agentDirFor(outDir), LOOP_DIR, expectedHash, "untrusted-loop-1", STATE_FILE);
	await flush(() => existsSync(expectedFile));
	check(
		"loopStateDir() untrusted → <agentDir>/loops/<sha1(cwd)[:12]>/<id>/state.json",
		existsSync(expectedFile),
		expectedFile,
	);
	if (existsSync(expectedFile)) {
		const parsed = JSON.parse(await fs.readFile(expectedFile, "utf8"));
		check(
			"loopStateDir() untrusted write contains the loop snapshot",
			parsed.loopId === "untrusted-loop-1",
			`id=${parsed.loopId}`,
		);
	}
}

function newerStatePicksLatest(mod) {
	const older = { loopId: "a", updatedAt: "2020-01-01T00:00:00.000Z" };
	const newer = { loopId: "a", updatedAt: "2021-01-01T00:00:00.000Z" };
	check("newerState() returns b when only b is defined", mod.newerState(undefined, newer) === newer);
	check("newerState() returns a when only a is defined", mod.newerState(older, undefined) === older);
	check("newerState() picks the later updatedAt", mod.newerState(older, newer) === newer);
	check("newerState() keeps a when a is later", mod.newerState(newer, older) === newer);
	check("newerState() treats missing updatedAt as oldest", mod.newerState({ loopId: "a" }, older) === older);
	const tiedRunning = { loopId: "tie", status: "running", updatedAt: newer.updatedAt };
	const tiedStopped = { loopId: "tie", status: "stopped", updatedAt: newer.updatedAt };
	check(
		"newerState() conservatively picks terminal b when updatedAt ties",
		mod.newerState(tiedRunning, tiedStopped) === tiedStopped,
	);
	check(
		"newerState() conservatively keeps terminal a when updatedAt ties",
		mod.newerState(tiedStopped, tiedRunning) === tiedStopped,
	);
	const tiedPaused = { loopId: "tie", status: "paused", updatedAt: newer.updatedAt };
	check(
		"newerState() preserves first-argument precedence for non-terminal ties",
		mod.newerState(tiedRunning, tiedPaused) === tiedRunning,
	);
}

async function readAndDiscoverSidecars(mod) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "loop-discover-"));
	const ctx = { isProjectTrusted: () => true, cwd };
	const { pi } = makePi();
	const loop = makeLoop({ loopId: "discover-me" });
	clearTimeout(loop.timer);
	mod.persist(pi, ctx, loop);
	const file = path.join(cwd, CONFIG_DIR_NAME, LOOP_DIR, "discover-me", STATE_FILE);
	await flush(() => existsSync(file));

	const read = await mod.readSidecar(ctx, "discover-me");
	check("readSidecar() returns the persisted loopId", read?.loopId === "discover-me", `id=${read?.loopId}`);
	check(
		"readSidecar() returns undefined for a missing loop",
		(await mod.readSidecar(ctx, "missing-loop")) === undefined,
	);

	const ids = await mod.discoverSidecarLoopIds(ctx);
	check(
		"discoverSidecarLoopIds() lists the sidecar directory",
		ids.includes("discover-me"),
		`ids=${JSON.stringify(ids)}`,
	);

	const escapedDir = path.join(cwd, "escape");
	await fs.mkdir(escapedDir, { recursive: true });
	await fs.writeFile(
		path.join(escapedDir, STATE_FILE),
		`${JSON.stringify(makeState({ loopId: "../../escape" }))}\n`,
		"utf8",
	);
	check(
		"readSidecar() rejects traversal instead of reading outside the canonical root",
		(await mod.readSidecar(ctx, "../../escape")) === undefined,
	);

	const mismatchedDir = path.join(cwd, CONFIG_DIR_NAME, LOOP_DIR, "discovered-safe");
	await fs.mkdir(mismatchedDir, { recursive: true });
	await fs.writeFile(
		path.join(mismatchedDir, STATE_FILE),
		`${JSON.stringify(makeState({ loopId: "../../escape" }))}\n`,
		"utf8",
	);
	check(
		"readSidecar() requires internal loopId to match the discovered directory",
		(await mod.readSidecar(ctx, "discovered-safe")) === undefined,
	);
	await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
}

async function main() {
	const { outDir, url } = await buildPersistence();
	try {
		const mod = await loadModule(url);
		persistAppendsAndStamps(mod);
		await persistReportsSidecarError(mod);
		await persistRejectsUnsafeLoopId(mod);
		await sidecarAtomicWriteTrustedRoot(mod);
		await sidecarTempCleanupOnRenameFailure(mod);
		await sidecarUntrustedRootUsesSha1Hash(mod, outDir);
		newerStatePicksLatest(mod);
		await readAndDiscoverSidecars(mod);
	} finally {
		await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
	}

	const controlled = await buildControlledPersistence();
	try {
		await sidecarKeepsLatestLogicalTransition(await loadModule(controlled.url));
	} finally {
		await fs.rm(controlled.outDir, { recursive: true, force: true }).catch(() => {});
	}

	console.log("");
	console.log(`TOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		console.log("FAILURES:");
		for (const f of counts.failures) console.log(`  - ${f}`);
		process.exit(1);
	}
	process.exit(0);
}

main().catch((err) => {
	console.error("INTEGRATION TEST CRASH:", err?.stack ? err.stack : err);
	process.exit(2);
});
