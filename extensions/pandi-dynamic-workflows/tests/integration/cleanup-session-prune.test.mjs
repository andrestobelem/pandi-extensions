#!/usr/bin/env node
/**
 * Contract test for the stale-Pi-session PRUNE policy (pi-session.ts,
 * classifySessionFilesForPrune).
 *
 * `collectPiSessions` already computes a `staleReason` for dead session records, but the
 * on-disk `.pi/live-sessions/*.json` file is never removed — it lingers until something
 * sweeps it (today, by hand). `/workflow cleanup sessions` removes those files, and this
 * pins the safe-by-default decision so the sweep can never delete a LIVE or the CURRENT
 * session's file:
 *
 *   - pid exited (process gone)      → remove (definitively safe)
 *   - live (pid alive + fresh)       → keep, always
 *   - the current session's file     → keep, always
 *   - heartbeat-stale (pid alive)    → keep by default; remove only with includeHeartbeatStale
 *   - malformed / unparseable record → keep (safe: never delete what we can't classify)
 *
 * `now` and `isPidAlive` are injected so the classifier is pure and offline; the IO wrapper
 * (prunePiSessionFiles) does the readdir + fs.unlink and is not exercised here.
 *
 * Run it:
 *   node extensions/pandi-dynamic-workflows/tests/integration/cleanup-session-prune.test.mjs
 */
import * as path from "node:path";
import { buildExtension, createChecker, REPO_ROOT, sdkStub } from "../../../shared/test/harness.mjs";

const { check, counts } = createChecker();

// PI_SESSION_STALE_MS in pi-session.ts.
const STALE_MS = 20_000;
const NOW = Date.parse("2026-07-01T00:00:00Z");

async function loadModule() {
	const { url } = await buildExtension({
		name: "pi-dwf-cleanup-session-prune",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "pi-session.ts"),
		outName: "pi-session.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
	});
	return await import(url);
}

const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
// entry({ file, pid, updatedMsAgo, id })
const entry = (file, pid, updatedMsAgo, id = file) => ({
	file,
	record: { id, pid, mode: "tui", cwd: "/proj", startedAt: iso(updatedMsAgo), updatedAt: iso(updatedMsAgo) },
});

async function main() {
	const { classifySessionFilesForPrune } = await loadModule();
	check(
		"exports classifySessionFilesForPrune",
		typeof classifySessionFilesForPrune === "function",
		typeof classifySessionFilesForPrune,
	);

	const deadPids = new Set([999]); // pid 999 is "dead"
	const isPidAlive = (pid) => !deadPids.has(pid);

	// Mixed fixture: dead, live, current, heartbeat-stale (pid alive but old heartbeat).
	const entries = [
		entry("dead.json", 999, 1000), // pid exited → remove
		entry("live.json", 100, 1000), // pid alive + fresh → keep
		entry("current.json", 200, 1000, "cur"), // current session → keep
		entry("hbstale.json", 300, STALE_MS + 5000), // pid alive, stale heartbeat → keep by default
	];

	// 1) Default: only pid-exited files are removed.
	{
		const { remove, keep } = classifySessionFilesForPrune(entries, { now: NOW, isPidAlive, currentId: "cur" });
		check("default removes only dead.json", remove.join(",") === "dead.json", JSON.stringify(remove));
		check(
			"default keeps live/current/heartbeat-stale",
			["live.json", "current.json", "hbstale.json"].every((f) => keep.includes(f)),
			JSON.stringify(keep),
		);
	}

	// 2) includeHeartbeatStale: also removes the pid-alive-but-stale file, but STILL keeps
	//    the current session and the live one.
	{
		const { remove, keep } = classifySessionFilesForPrune(entries, {
			now: NOW,
			isPidAlive,
			currentId: "cur",
			includeHeartbeatStale: true,
		});
		check(
			"includeHeartbeatStale removes dead + hbstale",
			remove.sort().join(",") === "dead.json,hbstale.json",
			JSON.stringify(remove),
		);
		check("current still kept", keep.includes("current.json"), JSON.stringify(keep));
		check("live still kept", keep.includes("live.json"), JSON.stringify(keep));
	}

	// 3) Current session is kept even if its pid looks dead (defensive: never delete our own).
	{
		const only = [entry("me.json", 999, 1000, "me")];
		const { remove, keep } = classifySessionFilesForPrune(only, {
			now: NOW,
			isPidAlive,
			currentId: "me",
			includeHeartbeatStale: true,
		});
		check(
			"current with dead pid still kept",
			remove.length === 0 && keep.includes("me.json"),
			JSON.stringify({ remove, keep }),
		);
	}

	// 4) Malformed / unparseable records are kept (never delete what we can't classify).
	{
		const bad = [
			{ file: "bad.json", record: null },
			{ file: "bad2.json", record: { pid: "nope" } },
		];
		const { remove, keep } = classifySessionFilesForPrune(bad, { now: NOW, isPidAlive });
		check("malformed records kept", remove.length === 0 && keep.length === 2, JSON.stringify({ remove, keep }));
	}

	// 5) Empty input → empty result.
	{
		const { remove, keep } = classifySessionFilesForPrune([], { now: NOW, isPidAlive });
		check("empty input → empty", remove.length === 0 && keep.length === 0);
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
