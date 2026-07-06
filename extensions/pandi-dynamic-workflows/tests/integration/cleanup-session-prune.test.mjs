#!/usr/bin/env node
/**
 * Test de contrato para la política PRUNE de sesiones Pi stale (pi-session.ts,
 * classifySessionFilesForPrune).
 *
 * `collectPiSessions` ya computa un `staleReason` para records de sesión muertos, pero el archivo
 * `.pi/live-sessions/*.json` en disco nunca se elimina — queda ahí hasta que algo
 * lo barre (hoy, a mano). `/workflow cleanup sessions` elimina esos archivos, y esto
 * pinea la decisión safe-by-default para que el barrido nunca pueda borrar un archivo de sesión
 * LIVE ni CURRENT:
 *
 *   - pid exited (proceso ausente)       → remove (definitivamente seguro)
 *   - live (pid vivo + fresco)          → keep, siempre
 *   - archivo de la sesión current      → keep, siempre
 *   - heartbeat-stale (pid vivo)        → keep por default; remove solo con includeHeartbeatStale
 *   - record malformed / no parseable   → keep (seguro: nunca borrar lo que no podemos clasificar)
 *
 * `now` e `isPidAlive` se inyectan para que el classifier sea puro y offline; el wrapper IO
 * (prunePiSessionFiles) hace el readdir + fs.unlink y no se ejercita acá.
 *
 * Corrélo:
 *   node extensions/pandi-dynamic-workflows/tests/integration/cleanup-session-prune.test.mjs
 */
import * as path from "node:path";
import { buildExtension, createChecker, REPO_ROOT, sdkStub } from "../../../shared/test/harness.mjs";

const { check, counts } = createChecker();

// PI_SESSION_STALE_MS en pi-session.ts.
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

	const deadPids = new Set([999]); // pid 999 está "dead"
	const isPidAlive = (pid) => !deadPids.has(pid);

	// Fixture mixto: dead, live, current, heartbeat-stale (pid vivo pero heartbeat viejo).
	const entries = [
		entry("dead.json", 999, 1000), // pid salió → remove
		entry("live.json", 100, 1000), // pid vivo + fresco → keep
		entry("current.json", 200, 1000, "cur"), // sesión current → keep
		entry("hbstale.json", 300, STALE_MS + 5000), // pid vivo, heartbeat stale → keep por default
	];

	// 1) Default: solo se eliminan archivos cuyo pid salió.
	{
		const { remove, keep } = classifySessionFilesForPrune(entries, { now: NOW, isPidAlive, currentId: "cur" });
		check("default removes only dead.json", remove.join(",") === "dead.json", JSON.stringify(remove));
		check(
			"default keeps live/current/heartbeat-stale",
			["live.json", "current.json", "hbstale.json"].every((f) => keep.includes(f)),
			JSON.stringify(keep),
		);
	}

	// 2) includeHeartbeatStale: también elimina el archivo con pid vivo pero stale, pero TODAVÍA conserva
	//    la sesión current y la live.
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

	// 3) La sesión current se conserva aunque su pid parezca muerto (defensivo: nunca borrar la propia).
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

	// 4) Records malformed / no parseables se conservan (nunca borrar lo que no podemos clasificar).
	{
		const bad = [
			{ file: "bad.json", record: null },
			{ file: "bad2.json", record: { pid: "nope" } },
		];
		const { remove, keep } = classifySessionFilesForPrune(bad, { now: NOW, isPidAlive });
		check("malformed records kept", remove.length === 0 && keep.length === 2, JSON.stringify({ remove, keep }));
	}

	// 5) Input vacío → resultado vacío.
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
