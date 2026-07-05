#!/usr/bin/env node
/**
 * Test de integración conductual durable para rutas de seguridad/lectura de `/bg`.
 *
 * Pinea el contrato M2 crítico para seguridad:
 * - `/bg plan` es solo dry-run y no crea artefactos runtime.
 * - `/bg list/status/logs` leen de forma segura artefactos confiables locales del proyecto
 *   y global fallback.
 * - las slash commands mutantes start/cancel se bloquean en plan mode.
 * - proyectos no confiables no inspeccionan artefactos locales `.pi/bg` y no pueden iniciar jobs.
 * - la salida de log es acotada/truncada y los job ids no pueden hacer path traversal.
 */

import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createChecker, loadDefault } from "../../../shared/test/harness.mjs";
import { buildBgWithPlan, createBgTestDir, loadExtension, makeCtx, makePi, setupJob } from "./bg-test-support.mjs";

const { check, counts } = createChecker();

function stableHash(value) {
	return crypto.createHash("sha1").update(value).digest("hex").slice(0, 12);
}

// Caracterización: pinea el refinamiento orphaned ACTUAL de handleStatus (dead -> interrupted;
// alive+verified -> orphaned/identity:verified; alive+different -> interrupted; alive+no-id
// -> orphaned de mejor esfuerzo) para que la extracción R2 de refineOrphanedIdentity no derive.
async function statusOrphanedRefinementPinned(url) {
	const { readProcessStartId } = await import(url);
	const { commands } = await loadExtension(url);
	const cwd = await createBgTestDir("pi-bg-orphan-refine-");
	const runsRoot = path.join(cwd, ".pi", "bg", "runs");
	const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
	const liveStartId = readProcessStartId(process.pid);
	await setupJob(runsRoot, "dead-pid", { state: "running", pid: dead.pid });
	await setupJob(runsRoot, "no-identity", { state: "running", pid: process.pid });
	await setupJob(runsRoot, "verified", {
		state: "running",
		pid: process.pid,
		startId: liveStartId,
	});
	await setupJob(runsRoot, "reused", {
		state: "running",
		pid: process.pid,
		startId: "stale:bogus-identity",
	});
	const ctx = makeCtx({ cwd, trusted: true });
	const statusOf = async (id) => {
		await commands.get("bg").handler(`status ${id}`, ctx);
		return ctx._notes.at(-1)?.msg || "";
	};
	check("orphan-refine: a dead pid projects interrupted", /"state": "interrupted"/.test(await statusOf("dead-pid")));
	const noId = await statusOf("no-identity");
	check(
		"orphan-refine: an alive pid without startId stays best-effort orphaned",
		/"state": "orphaned"/.test(noId) && !/"identity": "verified"/.test(noId),
		noId,
	);
	const ver = await statusOf("verified");
	if (process.platform === "win32") {
		check("orphan-refine: win32 keeps orphaned (identity unverifiable)", /"state": "orphaned"/.test(ver), ver);
	} else {
		check(
			"orphan-refine: a verified identity stays orphaned and is marked verified",
			/"state": "orphaned"/.test(ver) && /"identity": "verified"/.test(ver),
			ver,
		);
		check(
			"orphan-refine: a reused pid (different identity) projects interrupted",
			/"state": "interrupted"/.test(await statusOf("reused")),
		);
	}
}

// R1: happy path de /bg delete + eliminación symlink-safe + guard de path traversal.
async function deleteRemovesTerminalJobsAndGuards(url) {
	const { commands } = await loadExtension(url);
	const cwd = await createBgTestDir("pi-bg-delete-");
	const runsRoot = path.join(cwd, ".pi", "bg", "runs");
	const ctx = makeCtx({ cwd, trusted: true });
	const say = async (line) => {
		await commands.get("bg").handler(line, ctx);
		return ctx._notes.at(-1)?.msg || "";
	};
	const auditLines = async () =>
		(await fs.readFile(path.join(runsRoot, ".audit.jsonl"), "utf8").catch(() => ""))
			.trim()
			.split("\n")
			.filter(Boolean);

	const okDir = await setupJob(runsRoot, "done-job", { state: "completed" });
	const okMsg = await say("delete done-job");
	check("delete: a terminal job is removed", !existsSync(okDir), okDir);
	check("delete: reports the deletion", /eliminado/i.test(okMsg), okMsg);
	const audit = await auditLines();
	check(
		"delete: appends one audit line for the removal",
		audit.length === 1 && /"jobId":\s*"done-job"/.test(audit[0]) && /"verb":\s*"delete"/.test(audit[0]),
		JSON.stringify(audit),
	);

	const travMsg = await say("delete ../escape");
	check("delete: rejects a path-traversal id with usage", /Uso: \/bg delete/.test(travMsg), travMsg);

	const realDir = await createBgTestDir("pi-bg-delete-target-");
	await fs.writeFile(
		path.join(realDir, "status.json"),
		JSON.stringify({ jobId: "linky", state: "completed", updatedAt: "2026-06-25T00:00:00.000Z" }),
	);
	await fs.mkdir(runsRoot, { recursive: true });
	await fs.symlink(realDir, path.join(runsRoot, "linky"));
	const linkMsg = await say("delete linky");
	check("delete: refuses a symlinked run dir as not found", /no encontrado/i.test(linkMsg), linkMsg);
	check(
		"delete: symlink target survives the refusal",
		existsSync(realDir) && existsSync(path.join(realDir, "status.json")),
	);
}

// R3: scope/trust de /bg delete + bloqueo del escape por symlink interno (fs.rm deslinkea un
// symlink interno en vez de seguirlo, así que un destino externo sobrevive a la eliminación).
async function deleteEnforcesScopeTrustAndSymlinkEscape(url, agentDir) {
	const { commands } = await loadExtension(url);
	const cwd = await createBgTestDir("pi-bg-delete-scope-");
	const runsRoot = path.join(cwd, ".pi", "bg", "runs");
	const say = async (line, c) => {
		await commands.get("bg").handler(line, c);
		return c._notes.at(-1)?.msg || "";
	};

	// (a) Escape por symlink interno: eliminar el job dir deslinkea combined.log, nunca el destino.
	const okDir = await setupJob(runsRoot, "symlink-job", { state: "completed" });
	const external = await createBgTestDir("pi-bg-external-");
	const externalFile = path.join(external, "precious.txt");
	await fs.writeFile(externalFile, "do not delete me");
	await fs.symlink(externalFile, path.join(okDir, "combined.log"));
	await say("delete symlink-job", makeCtx({ cwd, trusted: true }));
	check("delete-scope: the run dir with an inner symlink is removed", !existsSync(okDir));
	check(
		"delete-scope: the external symlink target survives the removal",
		existsSync(externalFile) && (await fs.readFile(externalFile, "utf8")) === "do not delete me",
	);

	// (b) Job global-fallback: rechazado como read-only/fuera de scope; dir intacto.
	const globalRunsRoot = path.join(agentDir, "bg", "runs", stableHash(cwd));
	const globalDir = await setupJob(globalRunsRoot, "global-job", { state: "completed" });
	const globalMsg = await say("delete global-job", makeCtx({ cwd, trusted: true }));
	check(
		"delete-scope: refuses a global-fallback job",
		/global.*solo lectura|fuera de alcance/i.test(globalMsg),
		globalMsg,
	);
	check("delete-scope: the global job dir is left intact", existsSync(globalDir));

	// (c) Proyecto no confiable: no-op gateado por trust; dir intacto.
	const keepDir = await setupJob(runsRoot, "keep-job", { state: "completed" });
	const untrustedMsg = await say("delete keep-job", makeCtx({ cwd, trusted: false }));
	check("delete-scope: untrusted project is refused", /no confiable/i.test(untrustedMsg), untrustedMsg);
	check("delete-scope: untrusted leaves the dir intact", existsSync(keepDir));
}

async function deleteRejectedInPlanMode(planUrl, bgUrl) {
	const cwd = await createBgTestDir("pi-bg-delete-plan-");
	const { commands } = await loadPlanAndBg(planUrl, bgUrl);
	const ctx = makeCtx({ cwd, trusted: true });
	await commands.get("plan").handler("design safely", ctx);
	await commands.get("bg").handler("delete some-job", ctx);
	const msg = ctx._notes.at(-1)?.msg || "";
	check(
		"delete-plan: /bg delete rejected while plan mode active",
		/No se puede ejecutar \/bg delete mientras el modo plan está activo/.test(msg),
		msg,
	);
	await commands.get("plan").handler("exit", ctx);
}

// R6: delete/prune están completamente cableados (description, completions, ayuda de
// unknown-subcommand) y siguen siendo slash-only (sin LLM tool); no se filtró el verbo dashboard.
async function dispatcherExposesDeleteAndPrune(url) {
	const { commands, tools } = await loadExtension(url);
	const bg = commands.get("bg");
	check("wiring: registers no LLM tools (delete/prune are slash-only)", tools.size === 0, [...tools.keys()].join(","));
	check(
		"wiring: description advertises delete and prune",
		/delete/.test(bg.description) && /prune/.test(bg.description),
		bg.description,
	);
	check("wiring: description advertises no dashboard", !/dashboard/i.test(bg.description), bg.description);
	const comp = (prefix) => (bg.getArgumentCompletions ? bg.getArgumentCompletions(prefix) : []).map((i) => i.value);
	check("wiring: 'del' completes to delete", comp("del").includes("delete"), JSON.stringify(comp("del")));
	check("wiring: 'pru' completes to prune", comp("pru").includes("prune"), JSON.stringify(comp("pru")));
	check("wiring: no dashboard completion", !comp("").includes("dashboard"), JSON.stringify(comp("")));
	const ctx = makeCtx({
		cwd: await createBgTestDir("pi-bg-wiring-"),
		trusted: true,
	});
	await bg.handler("bogus", ctx);
	const unknownMsg = ctx._notes.at(-1)?.msg || "";
	check(
		"wiring: unknown-subcommand help lists delete and prune",
		/delete/.test(unknownMsg) && /prune/.test(unknownMsg),
		unknownMsg,
	);
}

async function auditDotfileIsInvisibleToList(url) {
	const { commands } = await loadExtension(url);
	const cwd = await createBgTestDir("pi-bg-dotfile-list-");
	const runsRoot = path.join(cwd, ".pi", "bg", "runs");
	await setupJob(runsRoot, "real-job", { state: "completed" });
	await fs.writeFile(
		path.join(runsRoot, ".audit.jsonl"),
		`${JSON.stringify({ ts: "x", verb: "delete", jobId: "real-job" })}\n`,
	);
	const ctx = makeCtx({ cwd, trusted: true });
	await commands.get("bg").handler("list", ctx);
	const msg = ctx._notes.at(-1)?.msg || "";
	check("audit-list: /bg list shows the real job", /real-job/.test(msg), msg);
	check("audit-list: /bg list never surfaces the .audit.jsonl dotfile", !/\.audit/.test(msg), msg);
}

async function loadPlanAndBg(planUrl, bgUrl) {
	const planExtension = await loadDefault(planUrl);
	const bgExtension = await loadDefault(bgUrl);
	const { pi, commands, tools } = makePi();
	planExtension(pi);
	bgExtension(pi);
	return { commands, tools };
}

async function dryRunHasNoRuntimeWrites(url) {
	const cwd = await createBgTestDir("pi-bg-project-");
	const { commands, tools } = await loadExtension(url);
	const ctx = makeCtx({ cwd, trusted: true });
	await commands.get("bg").handler("preview npm test", ctx);

	check("dry-run: registers /bg command", commands.has("bg"));
	check("dry-run: registers no LLM tools", tools.size === 0, `registered tools: ${[...tools.keys()].join(",")}`);
	check("dry-run: reports no job started", /Solo dry run/.test(ctx._notes.at(-1)?.msg || ""));
	check("dry-run: includes planned command", /npm test/.test(ctx._notes.at(-1)?.msg || ""));
	check("dry-run: creates no project .pi artifacts", !existsSync(path.join(cwd, ".pi")));
}

async function startCancelRejectInPlanMode(planUrl, bgUrl) {
	const cwd = await createBgTestDir("pi-bg-plan-guard-");
	const { commands, tools } = await loadPlanAndBg(planUrl, bgUrl);
	const ctx = makeCtx({ cwd, trusted: true });

	await commands.get("plan").handler("design safely", ctx);
	// Una carga posterior de plan.ts en el mismo proceso no debe ocultar un plan guard ya activo.
	const reloadedPlanExtension = await loadDefault(planUrl);
	reloadedPlanExtension(makePi().pi);
	await commands.get("bg").handler("start npm test", ctx);
	const startMsg = ctx._notes.at(-1)?.msg || "";
	check(
		"plan guard: /bg start rejected while plan mode active",
		/No se puede ejecutar \/bg start mientras el modo plan está activo/.test(startMsg),
	);
	check("plan guard: /bg start creates no project artifacts", !existsSync(path.join(cwd, ".pi")));

	await commands.get("bg").handler("cancel job-1", ctx);
	const cancelMsg = ctx._notes.at(-1)?.msg || "";
	check(
		"plan guard: /bg cancel rejected while plan mode active",
		/No se puede ejecutar \/bg cancel mientras el modo plan está activo/.test(cancelMsg),
	);
	// La superficie mutante de bg son solo slash commands humanas: debe registrar CERO LLM tools.
	// El map tools acá contiene solo lo registrado por las extensiones plan+bg bundleadas, así que
	// el invariante es "sin tool bg/background_job" (plan posee submit_plan + enter_plan_mode).
	// Se afirma por NAME de tool y no por un conteo congelado para que agregar tools de plan no
	// rompa este guard silenciosamente.
	check(
		"plan guard: still registers no background_job/bg LLM tools",
		!tools.has("background_job") && !tools.has("bg") && tools.has("submit_plan") && tools.has("enter_plan_mode"),
		`registered tools: ${[...tools.keys()].join(",")}`,
	);

	await commands.get("plan").handler("exit", ctx);
}

async function listStatusLogsReadExistingArtifacts(url, agentDir) {
	const cwd = await createBgTestDir("pi-bg-project-");
	const projectRunsRoot = path.join(cwd, ".pi", "bg", "runs");
	const globalRunsRoot = path.join(agentDir, "bg", "runs", stableHash(cwd));
	await setupJob(projectRunsRoot, "project-job", {
		command: "project cmd",
		state: "running",
		updatedAt: "2026-06-25T02:00:00.000Z",
	});
	await setupJob(globalRunsRoot, "global-job", {
		command: "global cmd",
		state: "completed",
		updatedAt: "2026-06-25T03:00:00.000Z",
		log: `${"A".repeat(2500)}BEGIN${"B".repeat(20_500)}TAIL`,
	});

	const { commands } = await loadExtension(url);
	const ctx = makeCtx({ cwd, trusted: true });
	await commands.get("bg").handler("list", ctx);
	const listMsg = ctx._notes.at(-1)?.msg || "";
	check("list: scans trusted project-local artifacts", /project-job/.test(listMsg));
	check("list: scans global fallback artifacts", /global-job/.test(listMsg));

	await commands.get("bg").handler("status global-job", ctx);
	const statusMsg = ctx._notes.at(-1)?.msg || "";
	check("status: reports job JSON", /global cmd/.test(statusMsg) && /completed/.test(statusMsg));
	check("status: includes artifact directory", /artifactsDir/.test(statusMsg));

	await commands.get("bg").handler("logs global-job", ctx);
	const logsMsg = ctx._notes.at(-1)?.msg || "";
	check("logs: truncates oversized combined.log", logsMsg.startsWith("[truncado a los últimos 20000 bytes]"));
	check("logs: keeps tail of oversized combined.log", logsMsg.includes("TAIL"));
	check("logs: drops old head of oversized combined.log", !logsMsg.includes("BEGIN"));
	check("logs: output remains bounded", logsMsg.length <= 20_080, `length=${logsMsg.length}`);
}

async function logTailDoesNotSplitUtf8(url) {
	const cwd = await createBgTestDir("pi-bg-utf8-");
	const runsRoot = path.join(cwd, ".pi", "bg", "runs");
	// Coloca un emoji de 4 bytes para que la ventana de últimos 20000 bytes empiece en un byte de continuación.
	const head = Buffer.from("A".repeat(10));
	const emoji = Buffer.from("\u{1F600}");
	const tail = Buffer.from("A".repeat(19997));
	const logBuf = Buffer.concat([head, emoji, tail]);
	await setupJob(runsRoot, "utf8-job", { command: "x", state: "completed", log: logBuf });

	const { commands } = await loadExtension(url);
	const ctx = makeCtx({ cwd, trusted: true });
	await commands.get("bg").handler("logs utf8-job", ctx);
	const msg = ctx._notes.at(-1)?.msg || "";
	check("utf8: oversized log is truncated", msg.startsWith("[truncado a los últimos 20000 bytes]"), msg.slice(0, 40));
	check("utf8: tail read does not emit a replacement char", !msg.includes("\uFFFD"), JSON.stringify(msg.slice(0, 40)));
}

async function emptyAndUntrustedBehavior(url, agentDir) {
	const emptyCwd = await createBgTestDir("pi-bg-empty-");
	let loaded = await loadExtension(url);
	let ctx = makeCtx({ cwd: emptyCwd, trusted: true });
	await loaded.commands.get("bg").handler("list", ctx);
	check(
		"empty: missing artifact roots returns empty list",
		/No se encontraron jobs en segundo plano/.test(ctx._notes.at(-1)?.msg || ""),
	);

	const cwd = await createBgTestDir("pi-bg-untrusted-");
	const projectRunsRoot = path.join(cwd, ".pi", "bg", "runs");
	const globalRunsRoot = path.join(agentDir, "bg", "runs", stableHash(cwd));
	await setupJob(projectRunsRoot, "project-only", {
		command: "must not be read",
		state: "running",
	});
	await setupJob(globalRunsRoot, "global-only", { command: "safe global", state: "completed" });

	loaded = await loadExtension(url);
	ctx = makeCtx({ cwd, trusted: false });
	await loaded.commands.get("bg").handler("list", ctx);
	const listMsg = ctx._notes.at(-1)?.msg || "";
	check("untrusted: does not inspect project-local .pi/bg", !/project-only/.test(listMsg));
	check("untrusted: still inspects global fallback", /global-only/.test(listMsg));

	await loaded.commands.get("bg").handler("status project-only", ctx);
	check("untrusted: project-local status is not found", /no encontrado/.test(ctx._notes.at(-1)?.msg || ""));

	await loaded.commands.get("bg").handler("status ..", ctx);
	check("security: path traversal job id is rejected", /Uso: \/bg status/.test(ctx._notes.at(-1)?.msg || ""));

	const startCwd = await createBgTestDir("pi-bg-untrusted-start-");
	ctx = makeCtx({ cwd: startCwd, trusted: false });
	await loaded.commands.get("bg").handler("start npm test", ctx);
	check(
		"untrusted: /bg start is rejected",
		/No se puede ejecutar \/bg start en un proyecto no confiable/.test(ctx._notes.at(-1)?.msg || ""),
	);
	check("untrusted: /bg start creates no project artifacts", !existsSync(path.join(startCwd, ".pi")));
}

async function symlinkedRunDirsAreRejected(url, agentDir) {
	const cwd = await createBgTestDir("pi-bg-symlink-");
	const globalRunsRoot = path.join(agentDir, "bg", "runs", stableHash(cwd));
	const projectRunsRoot = path.join(cwd, ".pi", "bg", "runs");
	const outsideRunsRoot = await createBgTestDir("pi-bg-outside-");
	const outsideRunDir = await setupJob(outsideRunsRoot, "outside", {
		command: "outside secret",
		state: "completed",
		log: "outside log",
	});
	for (const runsRoot of [globalRunsRoot, projectRunsRoot]) {
		await fs.mkdir(runsRoot, { recursive: true });
		await fs.symlink(outsideRunDir, path.join(runsRoot, "linked-job"), "dir");
	}

	let loaded = await loadExtension(url);
	let ctx = makeCtx({ cwd, trusted: false });
	await loaded.commands.get("bg").handler("list", ctx);
	check(
		"security: global list ignores symlinked run dirs",
		!/linked-job|outside secret/.test(ctx._notes.at(-1)?.msg || ""),
	);

	await loaded.commands.get("bg").handler("status linked-job", ctx);
	check("security: global status rejects symlinked run dirs", /no encontrado/.test(ctx._notes.at(-1)?.msg || ""));

	await loaded.commands.get("bg").handler("logs linked-job", ctx);
	check("security: global logs rejects symlinked run dirs", /no encontrado/.test(ctx._notes.at(-1)?.msg || ""));

	loaded = await loadExtension(url);
	ctx = makeCtx({ cwd, trusted: true });
	await loaded.commands.get("bg").handler("list", ctx);
	check(
		"security: project list ignores symlinked run dirs",
		!/linked-job|outside secret/.test(ctx._notes.at(-1)?.msg || ""),
	);

	await loaded.commands.get("bg").handler("status linked-job", ctx);
	check("security: project status rejects symlinked run dirs", /no encontrado/.test(ctx._notes.at(-1)?.msg || ""));

	await loaded.commands.get("bg").handler("logs linked-job", ctx);
	check("security: project logs rejects symlinked run dirs", /no encontrado/.test(ctx._notes.at(-1)?.msg || ""));
}

async function symlinkedArtifactRootsAreIgnored(url, agentDir) {
	const cwd = await createBgTestDir("pi-bg-rootlink-");
	const outsideRunsRoot = await createBgTestDir("pi-bg-rootlink-outside-");
	await setupJob(outsideRunsRoot, "root-link-job", {
		command: "outside root secret",
		state: "completed",
		log: "outside root log",
	});

	const projectRunsParent = path.join(cwd, ".pi", "bg");
	await fs.mkdir(projectRunsParent, { recursive: true });
	await fs.symlink(outsideRunsRoot, path.join(projectRunsParent, "runs"), "dir");

	let loaded = await loadExtension(url);
	let ctx = makeCtx({ cwd, trusted: true });
	await loaded.commands.get("bg").handler("list", ctx);
	check(
		"security: project list ignores symlinked artifact root",
		!/root-link-job|outside root secret/.test(ctx._notes.at(-1)?.msg || ""),
	);
	await loaded.commands.get("bg").handler("status root-link-job", ctx);
	check(
		"security: project status rejects symlinked artifact root",
		/no encontrado/.test(ctx._notes.at(-1)?.msg || ""),
	);
	await loaded.commands.get("bg").handler("logs root-link-job", ctx);
	check("security: project logs rejects symlinked artifact root", /no encontrado/.test(ctx._notes.at(-1)?.msg || ""));

	const globalRunsParent = path.join(agentDir, "bg", "runs");
	await fs.mkdir(globalRunsParent, { recursive: true });
	await fs.symlink(outsideRunsRoot, path.join(globalRunsParent, stableHash(cwd)), "dir");

	loaded = await loadExtension(url);
	ctx = makeCtx({ cwd, trusted: false });
	await loaded.commands.get("bg").handler("list", ctx);
	check(
		"security: global list ignores symlinked artifact root",
		!/root-link-job|outside root secret/.test(ctx._notes.at(-1)?.msg || ""),
	);
	await loaded.commands.get("bg").handler("status root-link-job", ctx);
	check("security: global status rejects symlinked artifact root", /no encontrado/.test(ctx._notes.at(-1)?.msg || ""));
	await loaded.commands.get("bg").handler("logs root-link-job", ctx);
	check("security: global logs rejects symlinked artifact root", /no encontrado/.test(ctx._notes.at(-1)?.msg || ""));
}

async function symlinkedArtifactFilesAreIgnored(url, agentDir) {
	const cwd = await createBgTestDir("pi-bg-filelink-");
	const runDir = path.join(agentDir, "bg", "runs", stableHash(cwd), "file-link-job");
	await fs.mkdir(runDir, { recursive: true });
	const outsideDir = await createBgTestDir("pi-bg-filelink-outside-");
	const outsideJob = path.join(outsideDir, "job.json");
	const outsideLog = path.join(outsideDir, "combined.log");
	await fs.writeFile(outsideJob, JSON.stringify({ jobId: "file-link-job", command: "outside secret" }));
	await fs.writeFile(outsideLog, "outside log secret");
	await fs.symlink(outsideJob, path.join(runDir, "job.json"));
	await fs.writeFile(
		path.join(runDir, "status.json"),
		JSON.stringify({
			jobId: "file-link-job",
			state: "completed",
			updatedAt: "2026-06-25T00:00:00.000Z",
		}),
	);
	await fs.symlink(outsideLog, path.join(runDir, "combined.log"));

	const { commands } = await loadExtension(url);
	const ctx = makeCtx({ cwd, trusted: false });
	await commands.get("bg").handler("status file-link-job", ctx);
	check("security: status ignores symlinked job.json files", !/outside secret/.test(ctx._notes.at(-1)?.msg || ""));

	await commands.get("bg").handler("logs file-link-job", ctx);
	check(
		"security: logs ignores symlinked log files",
		/No se encontraron logs/.test(ctx._notes.at(-1)?.msg || "") &&
			!/outside log secret/.test(ctx._notes.at(-1)?.msg || ""),
	);
}

async function corruptArtifactsAreTolerated(url) {
	const cwd = await createBgTestDir("pi-bg-corrupt-");
	const runDir = path.join(cwd, ".pi", "bg", "runs", "corrupt-job");
	await fs.mkdir(runDir, { recursive: true });
	await fs.writeFile(path.join(runDir, "job.json"), "{not-json");
	await fs.writeFile(path.join(runDir, "status.json"), "{not-json");
	await fs.writeFile(path.join(runDir, ".status.json.tmp"), "partial");

	const { commands } = await loadExtension(url);
	const ctx = makeCtx({ cwd, trusted: true });
	await commands.get("bg").handler("list", ctx);
	check(
		"corrupt: list does not crash and shows unknown job",
		/corrupt-job: unknown/.test(ctx._notes.at(-1)?.msg || ""),
		ctx._notes.at(-1)?.msg,
	);

	await commands.get("bg").handler("status corrupt-job", ctx);
	check(
		"corrupt: status does not crash",
		/"jobId": "corrupt-job"/.test(ctx._notes.at(-1)?.msg || ""),
		ctx._notes.at(-1)?.msg,
	);

	await commands.get("bg").handler("logs corrupt-job", ctx);
	check(
		"corrupt: missing logs are reported safely",
		/No se encontraron logs/.test(ctx._notes.at(-1)?.msg || ""),
		ctx._notes.at(-1)?.msg,
	);
}

async function eventsSubcommandReadsBoundedEvents(url) {
	const cwd = await createBgTestDir("pi-bg-events-");
	const runsRoot = path.join(cwd, ".pi", "bg", "runs");
	const runDir = await setupJob(runsRoot, "events-job", { command: "echo hi", state: "completed" });
	const events = `${[
		{ time: "2026-06-25T00:00:00.000Z", event: "start", jobId: "events-job", command: "echo hi" },
		{ time: "2026-06-25T00:00:01.000Z", event: "running", jobId: "events-job", pid: 4242 },
		{
			time: "2026-06-25T00:00:02.000Z",
			event: "finish",
			jobId: "events-job",
			state: "completed",
			exitCode: 0,
		},
	]
		.map((e) => JSON.stringify(e))
		.join("\n")}\n`;
	await fs.writeFile(path.join(runDir, "events.jsonl"), events);

	const { commands } = await loadExtension(url);
	const ctx = makeCtx({ cwd, trusted: true });

	await commands.get("bg").handler("events events-job", ctx);
	const msg = ctx._notes.at(-1)?.msg || "";
	check(
		"events: surfaces the lifecycle timeline",
		/"event":"start"/.test(msg) && /"event":"finish"/.test(msg),
		msg.slice(0, 120),
	);
	check("events: includes the running pid event", /"pid":4242/.test(msg), msg.slice(0, 200));

	await commands.get("bg").handler("events missing-job", ctx);
	check(
		"events: unknown job reports not found",
		/no encontrado/.test(ctx._notes.at(-1)?.msg || ""),
		ctx._notes.at(-1)?.msg,
	);

	await commands.get("bg").handler("events ..", ctx);
	check(
		"events: path traversal job id is rejected",
		/Uso: \/bg events/.test(ctx._notes.at(-1)?.msg || ""),
		ctx._notes.at(-1)?.msg,
	);

	const desc = commands.get("bg")?.description || "";
	check("events: command description lists events", /\bevents\b/.test(desc), desc);
	const completions = commands
		.get("bg")
		.getArgumentCompletions("ev")
		.map((c) => c.value);
	check("events: completions include events for prefix 'ev'", completions.includes("events"), completions.join(","));
}

async function planAliasStillPreviews(url) {
	const cwd = await createBgTestDir("pi-bg-plan-alias-");
	const { commands } = await loadExtension(url);
	const ctx = makeCtx({ cwd, trusted: true });
	// Backward-compat: el verbo deprecated `plan` todavía mapea al dry-run preview.
	await commands.get("bg").handler("plan npm test", ctx);
	check(
		"alias: deprecated /bg plan still previews (dry-run)",
		/Solo dry run/.test(ctx._notes.at(-1)?.msg || ""),
		ctx._notes.at(-1)?.msg,
	);
	check("alias: /bg plan creates no artifacts", !existsSync(path.join(cwd, ".pi")));
	const all = commands
		.get("bg")
		.getArgumentCompletions("")
		.map((c) => c.value);
	check("preview: completions promote preview", all.includes("preview"), all.join(","));
	check("preview: completions no longer promote plan", !all.includes("plan"), all.join(","));
	const pre = commands
		.get("bg")
		.getArgumentCompletions("pre")
		.map((c) => c.value);
	check("preview: prefix 'pre' completes to preview", pre.includes("preview"), pre.join(","));
}

async function sessionStartReconcilesInterruptedJobs(url) {
	const extension = await loadDefault(url);
	const handlers = new Map();
	const tools = new Map();
	const pi = {
		registerCommand: () => {},
		registerTool: (def) => tools.set(def.name, def),
		on: (event, handler) => handlers.set(event, handler),
		appendEntry: () => {},
		sendUserMessage: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
	};
	extension(pi);
	check(
		"session-start: registers a session_start handler",
		handlers.has("session_start"),
		[...handlers.keys()].join(","),
	);
	check("session-start: still registers no LLM tools", tools.size === 0, [...tools.keys()].join(","));
	if (!handlers.has("session_start")) return;
	const handler = handlers.get("session_start");
	const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);

	const seedDeadJob = async (jobId) => {
		const cwd = await createBgTestDir("pi-bg-session-start-");
		const runDir = path.join(cwd, ".pi", "bg", "runs", jobId);
		await fs.mkdir(runDir, { recursive: true });
		await fs.writeFile(
			path.join(runDir, "status.json"),
			JSON.stringify({ jobId, state: "running", pid: dead.pid, updatedAt: "2026-06-25T00:00:00.000Z" }, null, 2),
		);
		return { cwd, runDir };
	};
	const readState = async (runDir) => JSON.parse(await fs.readFile(path.join(runDir, "status.json"), "utf8")).state;

	// Sesión TUI: un job running muerto se reconcilia a interrupted en disco.
	const tui = await seedDeadJob("dead-on-start");
	await handler({}, makeCtx({ cwd: tui.cwd, trusted: true, mode: "tui" }));
	check(
		"session-start: dead running job is reconciled to interrupted (tui)",
		(await readState(tui.runDir)) === "interrupted",
		await readState(tui.runDir),
	);

	// Modo json no persistente: gateado off, el artefacto queda running.
	const json = await seedDeadJob("dead-json");
	await handler({}, makeCtx({ cwd: json.cwd, trusted: true, mode: "json" }));
	check(
		"session-start: json mode is gated off (no reconcile)",
		(await readState(json.runDir)) === "running",
		await readState(json.runDir),
	);
}

async function main() {
	const { url, planUrl, agentDir } = await buildBgWithPlan();
	await dryRunHasNoRuntimeWrites(url);
	await statusOrphanedRefinementPinned(url);
	await deleteRemovesTerminalJobsAndGuards(url);
	await deleteEnforcesScopeTrustAndSymlinkEscape(url, agentDir);
	await deleteRejectedInPlanMode(planUrl, url);
	await dispatcherExposesDeleteAndPrune(url);
	await auditDotfileIsInvisibleToList(url);
	await startCancelRejectInPlanMode(planUrl, url);
	await listStatusLogsReadExistingArtifacts(url, agentDir);
	await logTailDoesNotSplitUtf8(url);
	await emptyAndUntrustedBehavior(url, agentDir);
	await symlinkedRunDirsAreRejected(url, agentDir);
	await symlinkedArtifactRootsAreIgnored(url, agentDir);
	await symlinkedArtifactFilesAreIgnored(url, agentDir);
	await corruptArtifactsAreTolerated(url);
	await sessionStartReconcilesInterruptedJobs(url);
	await eventsSubcommandReadsBoundedEvents(url);
	await planAliasStillPreviews(url);

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.error(counts.failures.join("\n"));
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(2);
});
