#!/usr/bin/env node
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { bundle, createChecker, makeBuildDir } from "../../../../shared/test/harness.mjs";
import { buildDwfModule, dwfStubs, EXT_DIR } from "../dwf-test-support.mjs";

const CONTROLLED_FS_KEY = "__pandiDynamicWorkflowsSessionFsControl";
const { check, counts } = createChecker();

function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function makeCtx(cwd) {
	return {
		mode: "tui",
		cwd,
		isProjectTrusted: () => true,
		isIdle: () => true,
		sessionManager: {
			getSessionId: () => "session-id",
			getSessionFile: () => path.join(cwd, ".pi", "sessions", "session.jsonl"),
			getSessionName: () => "Session",
		},
	};
}

async function buildControlledSession() {
	const { outDir, aliases } = await makeBuildDir("pi-dwf-session-heartbeat-atomicity", dwfStubs());
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
		src: path.join(EXT_DIR, "pi-session.ts"),
		outDir,
		outName: "pi-session-controlled.mjs",
		aliases,
	});
	return { outDir, url };
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
	const { outDir, url } = await buildControlledSession();
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-session-heartbeat-atomicity-"));
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	let session;
	let tickHeartbeat;
	let currentControl;
	try {
		globalThis.setInterval = (callback) => {
			tickHeartbeat = callback;
			return { unref() {} };
		};
		globalThis.clearInterval = () => {};
		session = await import(url);
		const ctx = makeCtx(project);
		await session.startPiSessionHeartbeat({ reason: "atomicity" }, ctx);
		const initial = await session.collectPiSessions(ctx);
		const heartbeatFile = initial[0]?.file;
		if (!heartbeatFile || typeof tickHeartbeat !== "function") throw new Error("heartbeat fixture unavailable");
		const initialSnapshot = await fs.readFile(heartbeatFile, "utf8");

		currentControl = controlledWrite(heartbeatFile);
		globalThis[CONTROLLED_FS_KEY] = currentControl;
		tickHeartbeat();
		await currentControl.started.promise;
		const visibleDuringWrite = await fs.readFile(heartbeatFile, "utf8");
		check(
			"a paused write keeps the previous complete snapshot visible",
			visibleDuringWrite === initialSnapshot,
			visibleDuringWrite,
		);
		currentControl.release.resolve();
		await currentControl.finished.promise;
		await waitFor(async () => (await tempSiblings(heartbeatFile)).length === 0);
		await new Promise((resolve) => setImmediate(resolve));
		const committedSnapshot = await fs.readFile(heartbeatFile, "utf8");
		check(
			"a completed write publishes intact JSON",
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
			"a failed write preserves the last complete snapshot",
			afterFailedWrite === committedSnapshot,
			afterFailedWrite,
		);
		check(
			"a failed write cleans its temporary sibling",
			failedTempCleaned,
			JSON.stringify(await tempSiblings(heartbeatFile)),
		);

		currentControl = controlledWrite(heartbeatFile);
		globalThis[CONTROLLED_FS_KEY] = currentControl;
		tickHeartbeat();
		await currentControl.started.promise;
		let stopped = false;
		const stopping = session.stopPiSessionHeartbeat().then(() => {
			stopped = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		check("stop waits for an in-flight filesystem write", stopped === false);
		currentControl.release.resolve();
		await stopping;
		check(
			"stop prevents resurrection and leaves no temporary siblings",
			(await session.collectPiSessions(ctx)).length === 0 && (await tempSiblings(heartbeatFile)).length === 0,
		);
	} finally {
		currentControl?.release.resolve();
		delete globalThis[CONTROLLED_FS_KEY];
		await session?.stopPiSessionHeartbeat?.();
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
		await fs.rm(project, { recursive: true, force: true }).catch(() => {});
		await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
	}
}

async function main() {
	const { outDir, url } = await buildDwfModule({
		name: "pi-dwf-session-heartbeat",
		relPath: "pi-session.ts",
		outName: "pi-session.mjs",
	});
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-session-heartbeat-"));
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	try {
		const session = await import(url);
		const ctx = makeCtx(project);
		const writeStarted = deferred();
		const releaseWrite = deferred();
		let tickHeartbeat;
		let stopped = false;
		let firstGeneration;

		globalThis.setInterval = (callback) => {
			tickHeartbeat = callback;
			return { unref() {} };
		};
		globalThis.clearInterval = () => {};

		await session.startPiSessionHeartbeat({ reason: "startup" }, ctx);
		session.setPiSessionHeartbeatWriteHookForTests(async (generation) => {
			firstGeneration = generation;
			writeStarted.resolve();
			await releaseWrite.promise;
		});
		tickHeartbeat();
		await writeStarted.promise;

		const stopping = session.stopPiSessionHeartbeat().then(() => {
			stopped = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		check("stop waits for the in-flight heartbeat before removing", stopped === false);

		releaseWrite.resolve();
		await stopping;
		const afterStop = await session.collectPiSessions(ctx);
		check(
			"a paused heartbeat cannot recreate the file after stop",
			afterStop.length === 0,
			JSON.stringify(afterStop),
		);

		let restartedGeneration;
		session.setPiSessionHeartbeatWriteHookForTests(async (generation) => {
			restartedGeneration = generation;
		});
		await session.startPiSessionHeartbeat({ reason: "restart" }, ctx);
		check(
			"a later start uses a new generation",
			Number.isInteger(firstGeneration) &&
				Number.isInteger(restartedGeneration) &&
				restartedGeneration > firstGeneration,
			JSON.stringify({ firstGeneration, restartedGeneration }),
		);
		await session.stopPiSessionHeartbeat();
		session.setPiSessionHeartbeatWriteHookForTests();
	} finally {
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
		await fs.rm(project, { recursive: true, force: true }).catch(() => {});
		await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
	}

	await testAtomicHeartbeatWrites();

	if (counts.failed > 0) {
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
