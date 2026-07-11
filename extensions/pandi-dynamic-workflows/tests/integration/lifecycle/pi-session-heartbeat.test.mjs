#!/usr/bin/env node
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createChecker } from "../../../../shared/test/harness.mjs";
import { buildDwfModule } from "../dwf-test-support.mjs";

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
