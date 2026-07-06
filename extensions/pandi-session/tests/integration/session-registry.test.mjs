#!/usr/bin/env node
/**
 * Behavioral contract for pandi-session's standalone live-session registry.
 *
 * The registry belongs to pandi-session:
 * it writes its own heartbeat records, collects only project-local Pi TUI/RPC
 * sessions, classifies stale rows, and cleans up the current heartbeat on shutdown.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const { check, counts } = createChecker();

async function buildRegistry() {
	return await buildExtension({
		name: "pandi-session-registry",
		src: path.join(REPO_ROOT, "extensions", "pandi-session", "session-registry.ts"),
		outName: "session-registry.mjs",
		stubs: { sdk: (dir) => sdkStub(dir) },
	});
}

function makeCtx(cwd, { mode = "tui", trusted = true, name = "Current session" } = {}) {
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

async function main() {
	const { outDir, url } = await buildRegistry();
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pandi-session-registry-"));
	try {
		const registry = await import(url);
		const ctx = makeCtx(project);

		await registry.startPandiSessionHeartbeat({ reason: "startup" }, ctx);
		const live = await registry.collectPandiSessions(ctx);
		check("heartbeat creates one current live session", live.length === 1, JSON.stringify(live));
		check("current heartbeat is marked current", live[0]?.current === true, JSON.stringify(live[0]));
		check("current heartbeat is marked live", live[0]?.live === true, JSON.stringify(live[0]));
		check(
			"current heartbeat records session metadata",
			live[0]?.sessionName === "Current session",
			JSON.stringify(live[0]),
		);

		await registry.stopPandiSessionHeartbeat();
		const afterStop = await registry.collectPandiSessions(ctx);
		check("stop removes current heartbeat record", afterStop.length === 0, JSON.stringify(afterStop));

		await registry.startPandiSessionHeartbeat({ reason: "startup" }, makeCtx(project, { mode: "print" }));
		const printSessions = await registry.collectPandiSessions(ctx);
		check(
			"print/json sessions do not write live heartbeats",
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
			sessionName: "Stale session",
		});
		await registry.startPandiSessionHeartbeat({ reason: "startup" }, ctx);
		const mixed = await registry.collectPandiSessions(ctx);
		check(
			"current/live session sorts before stale rows",
			mixed[0]?.current === true && mixed[1]?.id === "stale",
			JSON.stringify(mixed),
		);
		check(
			"stale row explains dead pid",
			mixed[1]?.live === false && /pid exited/.test(mixed[1]?.staleReason ?? ""),
			JSON.stringify(mixed[1]),
		);

		const formatted = registry.formatPandiSessionList(mixed);
		check("text formatter identifies Pandi sessions", formatted.includes("Pandi sessions (2)"), formatted);
		check(
			"text formatter includes selected metadata",
			formatted.includes("Stale session") && formatted.includes("Current session"),
			formatted,
		);
	} finally {
		try {
			const registry = await import(`${url}?cleanup`);
			await registry.stopPandiSessionHeartbeat?.();
		} catch {}
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
