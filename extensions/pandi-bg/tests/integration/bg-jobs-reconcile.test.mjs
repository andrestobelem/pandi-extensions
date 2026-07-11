#!/usr/bin/env node
/**
 * Suite partida de bg-jobs.test.mjs — liveness, identity, reconcile, delete gates.
 *
 * Ejecutar: node extensions/pandi-bg/tests/integration/bg-jobs-reconcile.test.mjs
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadModule } from "../../../shared/test/harness.mjs";
import {
	createBgTestDir,
	loadExtension,
	makeCtx,
	readJson,
	runBgScenarios,
	startControlledJob,
	waitFor,
} from "./bg-test-support.mjs";

async function orphanedPidIsLabeledNotKilled(url, check) {
	const { commands } = await loadExtension(url);
	const cwd = await createBgTestDir("pi-bg-orphan-");
	const jobId = "fake-active";
	const runDir = path.join(cwd, ".pi", "bg", "runs", jobId);
	await fs.mkdir(runDir, { recursive: true });
	await fs.writeFile(
		path.join(runDir, "job.json"),
		JSON.stringify(
			{ jobId, command: "fake", cwd, createdAt: new Date().toISOString(), artifactsDir: runDir },
			null,
			2,
		),
	);
	// pid = este proceso de test vivo, no poseído por la sesión bg => orphaned (vivo en otro lado).
	await fs.writeFile(
		path.join(runDir, "status.json"),
		JSON.stringify({ jobId, state: "running", pid: process.pid, updatedAt: new Date().toISOString() }, null, 2),
	);
	const ctx = makeCtx({ cwd, trusted: true });
	await commands.get("bg").handler(`cancel ${jobId}`, ctx);
	check(
		"orphaned: cancel refuses non-owned persisted PID",
		/rechaz/i.test(ctx._notes.at(-1)?.msg || ""),
		ctx._notes.at(-1)?.msg,
	);
	check("orphaned: current process is still alive", process.kill(process.pid, 0));
	await commands.get("bg").handler(`status ${jobId}`, ctx);
	const statusMsg = ctx._notes.at(-1)?.msg || "";
	check("orphaned: live persisted PID is derived as orphaned", /"state": "orphaned"/.test(statusMsg), statusMsg);
	check("orphaned: persisted running state is reported", /"persistedState": "running"/.test(statusMsg), statusMsg);
	check(
		"orphaned: status surfaces a verify-before-kill hint",
		/"hint":/.test(statusMsg) && /reutilizado/.test(statusMsg),
		statusMsg,
	);
	await commands.get("bg").handler("list", ctx);
	check(
		"orphaned: list reflects orphaned state",
		/fake-active: orphaned/.test(ctx._notes.at(-1)?.msg || ""),
		ctx._notes.at(-1)?.msg,
	);
}

async function interruptedAndStaleStatesAreDerived(url, check) {
	const { commands } = await loadExtension(url);
	const cwd = await createBgTestDir("pi-bg-interrupted-");
	const runsRoot = path.join(cwd, ".pi", "bg", "runs");

	// (1) running persistido, pid registrado muerto (reaped) => interrupted.
	const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
	check(
		"interrupted: probe child exited cleanly",
		dead.status === 0,
		JSON.stringify({ status: dead.status, pid: dead.pid }),
	);
	const deadJob = "dead-job";
	const deadDir = path.join(runsRoot, deadJob);
	await fs.mkdir(deadDir, { recursive: true });
	await fs.writeFile(
		path.join(deadDir, "job.json"),
		JSON.stringify({ jobId: deadJob, command: "gone", cwd, createdAt: new Date().toISOString() }, null, 2),
	);
	await fs.writeFile(
		path.join(deadDir, "status.json"),
		JSON.stringify({ jobId: deadJob, state: "running", pid: dead.pid, updatedAt: new Date().toISOString() }, null, 2),
	);

	// (2) starting persistido SIN pid registrado => fallback stale (no se puede probar).
	const noPidJob = "nopid-job";
	const noPidDir = path.join(runsRoot, noPidJob);
	await fs.mkdir(noPidDir, { recursive: true });
	await fs.writeFile(
		path.join(noPidDir, "job.json"),
		JSON.stringify({ jobId: noPidJob, command: "starting", cwd, createdAt: new Date().toISOString() }, null, 2),
	);
	await fs.writeFile(
		path.join(noPidDir, "status.json"),
		JSON.stringify({ jobId: noPidJob, state: "starting", updatedAt: new Date().toISOString() }, null, 2),
	);

	const ctx = makeCtx({ cwd, trusted: true });
	await commands.get("bg").handler(`status ${deadJob}`, ctx);
	const deadMsg = ctx._notes.at(-1)?.msg || "";
	check("interrupted: dead persisted PID is derived as interrupted", /"state": "interrupted"/.test(deadMsg), deadMsg);
	check("interrupted: persisted running state is reported", /"persistedState": "running"/.test(deadMsg), deadMsg);

	await commands.get("bg").handler(`status ${noPidJob}`, ctx);
	const noPidMsg = ctx._notes.at(-1)?.msg || "";
	check("stale: unprobeable (no pid) job falls back to stale", /"state": "stale"/.test(noPidMsg), noPidMsg);
	check("stale: persisted starting state is reported", /"persistedState": "starting"/.test(noPidMsg), noPidMsg);

	await commands.get("bg").handler("list", ctx);
	const listMsg = ctx._notes.at(-1)?.msg || "";
	check("list: reflects interrupted state", /dead-job: interrupted/.test(listMsg), listMsg);
	check("list: reflects stale fallback state", /nopid-job: stale/.test(listMsg), listMsg);
}

async function processStartIdCapturesIdentity(url, check) {
	const mod = await loadModule(url);
	const readStartId = mod.readProcessStartId;
	check("startid: readProcessStartId is exported", typeof readStartId === "function", typeof readStartId);
	if (typeof readStartId !== "function") return;
	check(
		"startid: invalid pids yield undefined",
		readStartId(undefined) === undefined &&
			readStartId(0) === undefined &&
			readStartId(-1) === undefined &&
			readStartId(1.5) === undefined,
	);
	const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
	check(
		"startid: probe child exited cleanly",
		dead.status === 0,
		JSON.stringify({ status: dead.status, pid: dead.pid }),
	);
	if (process.platform === "win32") {
		// La captura de identidad en Windows se difiere (degradación graceful a liveness de mejor esfuerzo).
		check(
			"startid: win32 identity capture is deferred (undefined)",
			readStartId(process.pid) === undefined,
			String(readStartId(process.pid)),
		);
	} else {
		const self = readStartId(process.pid);
		check(
			"startid: a live process yields a non-empty identity",
			typeof self === "string" && self.length > 0,
			String(self),
		);
		check(
			"startid: a reaped pid yields undefined",
			readStartId(dead.pid) === undefined,
			String(readStartId(dead.pid)),
		);
	}
}

async function livenessProbeClassifiesPids(url, check) {
	const mod = await loadModule(url);
	const probe = mod.probeProcessAlive;
	check("liveness: probeProcessAlive is exported", typeof probe === "function", typeof probe);
	if (typeof probe !== "function") return;
	// Una prueba signal-0 no envía señal; solo pregunta si algún proceso posee el pid.
	check("liveness: current process is alive", probe(process.pid) === "alive", String(probe(process.pid)));
	check("liveness: undefined pid is unknown", probe(undefined) === "unknown", String(probe(undefined)));
	check(
		"liveness: zero/negative/non-integer pid is unknown",
		probe(0) === "unknown" && probe(-1) === "unknown" && probe(1.5) === "unknown",
		JSON.stringify([probe(0), probe(-1), probe(1.5)]),
	);
	// Spawnea un child de vida corta y deja que spawnSync lo reap, luego prueba su pid ya muerto.
	const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
	check(
		"liveness: spawned probe child exited cleanly",
		dead.status === 0,
		JSON.stringify({ status: dead.status, pid: dead.pid }),
	);
	check("liveness: a reaped child pid is dead", probe(dead.pid) === "dead", String(probe(dead.pid)));
}

async function reconcileRewritesDeadRunningJobs(url, check) {
	const mod = await loadModule(url);
	const reconcile = mod.reconcileInterruptedJobs;
	check("reconcile: reconcileInterruptedJobs is exported", typeof reconcile === "function", typeof reconcile);
	if (typeof reconcile !== "function") return;

	const cwd = await createBgTestDir("pi-bg-reconcile-");
	const runsRoot = path.join(cwd, ".pi", "bg", "runs");
	const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
	check(
		"reconcile: probe child exited cleanly",
		dead.status === 0,
		JSON.stringify({ status: dead.status, pid: dead.pid }),
	);
	const write = async (jobId, status) => {
		const dir = path.join(runsRoot, jobId);
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(
			path.join(dir, "job.json"),
			JSON.stringify({ jobId, command: jobId, cwd, createdAt: new Date().toISOString() }, null, 2),
		);
		await fs.writeFile(
			path.join(dir, "status.json"),
			JSON.stringify({ jobId, updatedAt: new Date().toISOString(), ...status }, null, 2),
		);
		return dir;
	};
	const deadDir = await write("dead-run", { state: "running", pid: dead.pid });
	const aliveDir = await write("alive-run", { state: "running", pid: process.pid });
	const noPidDir = await write("nopid-run", { state: "starting" });
	const doneDir = await write("done-run", { state: "completed", exitCode: 0 });

	const ctx = makeCtx({ cwd, trusted: true });
	const n = await reconcile(ctx);
	check("reconcile: reconciles exactly the one dead running job", n === 1, String(n));

	const deadStatus = await readJson(path.join(deadDir, "status.json"));
	check(
		"reconcile: dead running job becomes interrupted",
		deadStatus.state === "interrupted",
		JSON.stringify(deadStatus),
	);
	check(
		"reconcile: interrupted job records a reason",
		deadStatus.reason === "session-start-reconcile",
		JSON.stringify(deadStatus),
	);
	check(
		"reconcile: interrupted job records completedAt",
		typeof deadStatus.completedAt === "string",
		JSON.stringify(deadStatus),
	);

	const aliveStatus = await readJson(path.join(aliveDir, "status.json"));
	check(
		"reconcile: live running job is left as running on disk",
		aliveStatus.state === "running",
		JSON.stringify(aliveStatus),
	);
	const noPidStatus = await readJson(path.join(noPidDir, "status.json"));
	check(
		"reconcile: unprobeable (no pid) job is left untouched",
		noPidStatus.state === "starting",
		JSON.stringify(noPidStatus),
	);
	const doneStatus = await readJson(path.join(doneDir, "status.json"));
	check("reconcile: terminal job is left untouched", doneStatus.state === "completed", JSON.stringify(doneStatus));

	const n2 = await reconcile(ctx);
	check("reconcile: idempotent second pass changes nothing", n2 === 0, String(n2));
	const temps = (await fs.readdir(deadDir)).filter((f) => f.includes(".tmp"));
	check("reconcile: leaves no temp files behind", temps.length === 0, temps.join(","));

	const untrustedCwd = await createBgTestDir("pi-bg-reconcile-untrusted-");
	const uDir = path.join(untrustedCwd, ".pi", "bg", "runs", "dead-untrusted");
	await fs.mkdir(uDir, { recursive: true });
	await fs.writeFile(
		path.join(uDir, "status.json"),
		JSON.stringify(
			{
				jobId: "dead-untrusted",
				state: "running",
				pid: dead.pid,
				updatedAt: new Date().toISOString(),
			},
			null,
			2,
		),
	);
	const nUntrusted = await reconcile(makeCtx({ cwd: untrustedCwd, trusted: false }));
	check("reconcile: untrusted project is not reconciled", nUntrusted === 0, String(nUntrusted));
	const untrustedStatus = await readJson(path.join(uDir, "status.json"));
	check(
		"reconcile: untrusted status left as running",
		untrustedStatus.state === "running",
		JSON.stringify(untrustedStatus),
	);
}

async function verifyProcessIdentityDetectsReuse(url, check) {
	const mod = await loadModule(url);
	const verify = mod.verifyProcessIdentity;
	const readStartId = mod.readProcessStartId;
	check("verify: verifyProcessIdentity is exported", typeof verify === "function", typeof verify);
	if (typeof verify !== "function") return;
	check(
		"verify: missing recorded identity is unknown",
		verify(process.pid, undefined) === "unknown",
		String(verify(process.pid, undefined)),
	);
	const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
	check(
		"verify: a dead pid cannot be confirmed (unknown)",
		verify(dead.pid, "anything") === "unknown",
		String(verify(dead.pid, "anything")),
	);
	if (process.platform === "win32") {
		check(
			"verify: win32 cannot verify identity (unknown)",
			verify(process.pid, "stale:bogus") === "unknown",
			String(verify(process.pid, "stale:bogus")),
		);
	} else {
		const id = readStartId(process.pid);
		check("verify: matching identity is same", verify(process.pid, id) === "same", String(verify(process.pid, id)));
		check(
			"verify: stale identity is different (pid reused)",
			verify(process.pid, "stale:bogus") === "different",
			String(verify(process.pid, "stale:bogus")),
		);
	}
}

async function identityDefeatsPidReuse(url, check) {
	const mod = await loadModule(url);
	const readStartId = mod.readProcessStartId;
	const reconcile = mod.reconcileInterruptedJobs;
	const { commands } = await loadExtension(url);
	const cwd = await createBgTestDir("pi-bg-identity-");
	const runsRoot = path.join(cwd, ".pi", "bg", "runs");
	const liveId = readStartId(process.pid);
	const write = async (jobId, status) => {
		const dir = path.join(runsRoot, jobId);
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(
			path.join(dir, "job.json"),
			JSON.stringify({ jobId, command: jobId, cwd, createdAt: new Date().toISOString() }, null, 2),
		);
		await fs.writeFile(
			path.join(dir, "status.json"),
			JSON.stringify({ jobId, updatedAt: new Date().toISOString(), ...status }, null, 2),
		);
		return dir;
	};
	// pid alive (este proceso) pero startId registrado stale => el pid fue reutilizado.
	const reusedDir = await write("reused", {
		state: "running",
		pid: process.pid,
		startId: "stale:bogus-identity",
	});
	// pid alive Y startId registrado coincide => proceso huérfano genuinamente nuestro.
	const verifiedDir = await write("verified", {
		state: "running",
		pid: process.pid,
		startId: liveId,
	});
	const ctx = makeCtx({ cwd, trusted: true });
	const win32 = process.platform === "win32";

	await commands.get("bg").handler("status reused", ctx);
	const reusedMsg = ctx._notes.at(-1)?.msg || "";
	await commands.get("bg").handler("status verified", ctx);
	const verifiedMsg = ctx._notes.at(-1)?.msg || "";
	if (win32) {
		check("identity: win32 status keeps best-effort orphaned", /"state": "orphaned"/.test(reusedMsg), reusedMsg);
	} else {
		check(
			"identity: status downgrades a reused pid to interrupted",
			/"state": "interrupted"/.test(reusedMsg),
			reusedMsg,
		);
		check(
			"identity: status keeps a verified orphan as orphaned",
			/"state": "orphaned"/.test(verifiedMsg) && /"identity": "verified"/.test(verifiedMsg),
			verifiedMsg,
		);
	}

	const n = await reconcile(ctx);
	const reusedState = JSON.parse(await fs.readFile(path.join(reusedDir, "status.json"), "utf8")).state;
	const verifiedState = JSON.parse(await fs.readFile(path.join(verifiedDir, "status.json"), "utf8")).state;
	if (win32) {
		check("identity: win32 reconcile leaves reused pid running", reusedState === "running", reusedState);
	} else {
		check("identity: reconcile rewrites a reused pid to interrupted", reusedState === "interrupted", reusedState);
		check("identity: reconcile leaves a verified orphan running", verifiedState === "running", verifiedState);
		check("identity: reconcile reports rewriting the reused job", n >= 1, String(n));
	}
}

async function deleteGateReDerivesLiveState(url, check) {
	const mod = await loadModule(url);
	const readStartId = mod.readProcessStartId;
	const { commands } = await loadExtension(url);
	const cwd = await createBgTestDir("pi-bg-delete-gate-");
	const runsRoot = path.join(cwd, ".pi", "bg", "runs");
	const ctx = makeCtx({ cwd, trusted: true });
	const win32 = process.platform === "win32";
	const seed = async (jobId, status) => {
		const dir = path.join(runsRoot, jobId);
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(
			path.join(dir, "job.json"),
			JSON.stringify({ jobId, command: jobId, cwd, createdAt: new Date().toISOString() }, null, 2),
		);
		await fs.writeFile(
			path.join(dir, "status.json"),
			JSON.stringify({ jobId, updatedAt: new Date().toISOString(), ...status }, null, 2),
		);
		return dir;
	};
	const del = async (jobId) => {
		await commands.get("bg").handler(`delete ${jobId}`, ctx);
		return ctx._notes.at(-1)?.msg || "";
	};

	const aliveDir = await seed("alive-orphan", {
		state: "running",
		pid: process.pid,
		startId: readStartId(process.pid),
	});
	const aliveMsg = await del("alive-orphan");
	check("delete-gate: refuses a verified-alive orphan", existsSync(aliveDir), aliveMsg);
	if (!win32) check("delete-gate: explains the alive refusal", /no se puede eliminar|vivo/i.test(aliveMsg), aliveMsg);

	const unkDir = await seed("unknown-orphan", { state: "running", pid: process.pid });
	const unkMsg = await del("unknown-orphan");
	check("delete-gate: refuses an unknown-identity orphan", existsSync(unkDir), unkMsg);

	const reusedDir = await seed("reused-pid", {
		state: "running",
		pid: process.pid,
		startId: "stale:bogus-identity",
	});
	const reusedMsg = await del("reused-pid");
	if (win32) {
		check("delete-gate: win32 keeps a reused-pid orphan (unverifiable)", existsSync(reusedDir), reusedMsg);
	} else {
		check(
			"delete-gate: deletes a reused-pid job (refined to interrupted)",
			!existsSync(reusedDir) && /eliminado/i.test(reusedMsg),
			reusedMsg,
		);
	}

	const job = await startControlledJob(commands, cwd, { check });
	await waitFor("active job is owned", async () => {
		await commands.get("bg").handler(`status ${job.jobId}`, job.ctx);
		return /"active": true/.test(job.ctx._notes.at(-1)?.msg || "");
	});
	const activeMsg = await del(job.jobId);
	check("delete-gate: refuses a job active in this session", existsSync(job.runDir), activeMsg);
	check("delete-gate: explains the active refusal", /activ/i.test(activeMsg), activeMsg);
	await fs.writeFile(job.release, "go");
	await waitFor(
		"active job finished",
		async () => (await readJson(path.join(job.runDir, "status.json")))?.state === "completed",
	);
}

async function removeRunDirRevalidatesBeforeRm(url, check) {
	const mod = await loadModule(url);
	const removeRunDir = mod.removeRunDir;
	check("revalidate: removeRunDir is exported", typeof removeRunDir === "function", typeof removeRunDir);
	if (typeof removeRunDir !== "function") return;
	const cwd = await createBgTestDir("pi-bg-revalidate-");
	const dir = path.join(cwd, ".pi", "bg", "runs", "guard-job");
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(
		path.join(dir, "status.json"),
		JSON.stringify({ jobId: "guard-job", state: "completed", updatedAt: new Date().toISOString() }, null, 2),
	);
	const ctx = makeCtx({ cwd, trusted: true });
	const aborted = await removeRunDir(ctx, "guard-job", { verb: "delete" }, async () => false);
	check(
		"revalidate: an aborting re-check leaves the dir intact",
		aborted === false && existsSync(dir),
		`aborted=${aborted}`,
	);
	const removed = await removeRunDir(ctx, "guard-job", { verb: "delete" }, async () => true);
	check("revalidate: a passing re-check removes the dir", removed === true && !existsSync(dir), `removed=${removed}`);
}

async function main() {
	await runBgScenarios({
		name: "pi-bg-jobs-reconcile",
		scenarios: [
			orphanedPidIsLabeledNotKilled,
			interruptedAndStaleStatesAreDerived,
			processStartIdCapturesIdentity,
			livenessProbeClassifiesPids,
			reconcileRewritesDeadRunningJobs,
			verifyProcessIdentityDetectsReuse,
			identityDefeatsPidReuse,
			deleteGateReDerivesLiveState,
			removeRunDirRevalidatesBeforeRm,
		],
	});
}

main().catch((err) => {
	console.error(err?.stack || err);
	process.exit(1);
});
