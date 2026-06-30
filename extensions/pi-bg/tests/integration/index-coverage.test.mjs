#!/usr/bin/env node
/**
 * Characterization coverage for index.ts command-dispatch branches that the
 * primary bg-jobs suite does not exercise: the top-level try/catch error
 * response, the duplicate-cancel branch, cancelPersistedJob's reused/unknown
 * identity refusal, handleDelete's non-deletable refusal, handlePrune's
 * untrusted + plan-mode gates, and reconcileInterruptedJobs skipping a job that
 * is active in this session.
 *
 * All assertions go through the registered `/bg` command handler (which calls
 * ctx.ui.notify with only { message, type } — details are NOT surfaced there, so
 * we assert on the message text and type), or through the exported
 * reconcileInterruptedJobs. The source is the source of truth; these tests
 * record its CURRENT behavior.
 */

import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, loadModule, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

const skipped = [];

function shellQuote(value) {
	return JSON.stringify(value);
}

async function buildBg() {
	const { url } = await buildExtension({
		name: "pi-bg-index-coverage",
		src: path.join(REPO_ROOT, "extensions", "pi-bg", "index.ts"),
		outName: "bg.mjs",
		stubs: { sdk: (dir) => sdkStub(dir) },
		npx: "--no-install",
	});
	return { url };
}

function makePi() {
	const commands = new Map();
	const tools = new Map();
	return {
		pi: {
			registerCommand: (name, opts) => commands.set(name, opts),
			registerTool: (def) => tools.set(def.name, def),
			on: () => {},
			appendEntry: () => {},
			sendUserMessage: () => {},
			exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
		},
		commands,
		tools,
	};
}

function makeCtx({ cwd, trusted = true, mode = "tui", hasUI = true } = {}) {
	const notes = [];
	const ctx = {
		mode,
		hasUI,
		cwd,
		isProjectTrusted: () => trusted,
		isIdle: () => true,
		ui: {
			notify: (msg, type) => notes.push({ msg, type }),
			setStatus: () => {},
			theme: { fg: (_c, s) => s },
		},
		sessionManager: { getEntries: () => [] },
	};
	ctx._notes = notes;
	return ctx;
}

async function loadExtension(url) {
	const extension = await loadDefault(url);
	const { pi, commands, tools } = makePi();
	extension(pi);
	return { commands, tools };
}

function parseJobId(message) {
	return /Started background job ([A-Za-z0-9_-]+(?:-[A-Za-z0-9_-]+)*)\./.exec(message)?.[1];
}

async function readJson(file) {
	return JSON.parse(await fs.readFile(file, "utf8"));
}

async function waitFor(label, fn, { timeoutMs = 6000, intervalMs = 25 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		try {
			last = await fn();
			if (last) return last;
		} catch (err) {
			last = err;
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(`Timed out waiting for ${label}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

// Start a child that runs until killed; returns { jobId, runDir, cleanup }.
async function startLongJob(commands, cwd) {
	const script = path.join(cwd, `long-${Math.random().toString(16).slice(2)}.cjs`);
	const started = path.join(cwd, `started-${Math.random().toString(16).slice(2)}`);
	await fs.writeFile(
		script,
		`const fs = require("node:fs");\n` +
			`fs.writeFileSync(process.argv[2], "started");\n` +
			`setInterval(() => {}, 1000);\n`,
	);
	const ctx = makeCtx({ cwd, trusted: true });
	const command = `${shellQuote(process.execPath)} ${shellQuote(script)} ${shellQuote(started)}`;
	await commands.get("bg").handler(`start ${command}`, ctx);
	const jobId = parseJobId(ctx._notes.at(-1)?.msg || "");
	const runDir = path.join(cwd, ".pi", "bg", "runs", jobId || "missing");
	await waitFor("long job started handshake", async () => existsSync(started));
	await waitFor("long job running status", async () => {
		const s = await readJson(path.join(runDir, "status.json"));
		return s.state === "running" ? s : false;
	});
	const cleanup = async () => {
		await commands.get("bg").handler(`cancel ${jobId}`, ctx);
	};
	return { ctx, jobId, runDir, cleanup };
}

// ── Gap 1: handleBgCommand top-level try/catch ───────────────────────────────
async function topLevelCatchReturnsErrorResponse(url) {
	const { commands } = await loadExtension(url);
	// A non-string cwd makes candidateRunRoots(ctx) -> path.join throw synchronously
	// inside handleList (a non-ENOENT error), exercising the dispatch try/catch.
	const ctx = makeCtx({ cwd: 12345, trusted: true });
	let threw = false;
	try {
		await commands.get("bg").handler("list", ctx);
	} catch {
		threw = true;
	}
	const note = ctx._notes.at(-1) || {};
	check("catch: handler does not throw out of the dispatch try/catch", !threw);
	check("catch: surfaces a `/bg failed:` message", /\/bg failed:/.test(note.msg || ""), JSON.stringify(note));
	check("catch: response uses the 'error' type", note.type === "error", JSON.stringify(note));
}

// ── Gap 2: handleCancel duplicate-request branch ─────────────────────────────
async function duplicateCancelIsReported(url) {
	const { commands } = await loadExtension(url);
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-dup-cancel-"));
	const job = await startLongJob(commands, cwd);
	try {
		await commands.get("bg").handler(`cancel ${job.jobId}`, job.ctx);
		check(
			"dup-cancel: first cancel is accepted",
			/Cancel requested/.test(job.ctx._notes.at(-1)?.msg || ""),
			job.ctx._notes.at(-1)?.msg,
		);
		await commands.get("bg").handler(`cancel ${job.jobId}`, job.ctx);
		const msg = job.ctx._notes.at(-1)?.msg || "";
		check("dup-cancel: second cancel reports already-requested", /Cancellation already requested/.test(msg), msg);
		const events = await fs.readFile(path.join(job.runDir, "events.jsonl"), "utf8").catch(() => "");
		const requests = (events.match(/"event":"cancel-requested"/g) || []).length;
		check("dup-cancel: only a single cancel-requested event is recorded", requests === 1, String(requests));
	} finally {
		await waitFor(
			"dup-cancel job terminal",
			async () => ["cancelled", "completed", "failed"].includes((await readJson(path.join(job.runDir, "status.json"))).state),
			{ timeoutMs: 8000 },
		).catch(() => {});
	}
}

// ── Gap 4: cancelPersistedJob reused/unknown identity refusal ────────────────
async function cancelPersistedRefusesReusedIdentity(url) {
	const { commands } = await loadExtension(url);
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-persist-reuse-"));
	const jobId = "reused-persisted";
	const runDir = path.join(cwd, ".pi", "bg", "runs", jobId);
	await fs.mkdir(runDir, { recursive: true });
	await fs.writeFile(
		path.join(runDir, "job.json"),
		JSON.stringify({ jobId, command: "x", cwd, createdAt: new Date().toISOString(), artifactsDir: runDir }, null, 2),
	);
	// Live pid (this process) + stale recorded identity => verifyProcessIdentity is
	// "different" on POSIX (pid reused) and "unknown" on win32 (cannot verify).
	await fs.writeFile(
		path.join(runDir, "status.json"),
		JSON.stringify(
			{ jobId, state: "running", pid: process.pid, startId: "stale:bogus-identity", updatedAt: new Date().toISOString() },
			null,
			2,
		),
	);
	const ctx = makeCtx({ cwd, trusted: true });
	await commands.get("bg").handler(`cancel ${jobId}`, ctx);
	const msg = ctx._notes.at(-1)?.msg || "";
	check("persist-reuse: current process is never signaled", process.kill(process.pid, 0));
	const status = await readJson(path.join(runDir, "status.json"));
	check("persist-reuse: status is left running (not cancelled)", status.state === "running", JSON.stringify(status));
	check("persist-reuse: refuses to cancel", /Refusing to cancel/.test(msg), msg);
	if (process.platform === "win32") {
		check("persist-reuse: win32 cites unverifiable identity", /could not be verified/.test(msg), msg);
	} else {
		check("persist-reuse: POSIX cites a reused PID", /was reused/.test(msg), msg);
	}
}

// ── Gap 5: handleDelete non-deletable (live/orphaned) refusal ────────────────
async function deleteRefusesLiveOrphan(url) {
	const { commands } = await loadExtension(url);
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-delete-live-"));
	const jobId = "live-orphan";
	const runDir = path.join(cwd, ".pi", "bg", "runs", jobId);
	await fs.mkdir(runDir, { recursive: true });
	await fs.writeFile(
		path.join(runDir, "job.json"),
		JSON.stringify({ jobId, command: "x", cwd, createdAt: new Date().toISOString() }, null, 2),
	);
	// state=running + alive pid (this process), no startId => orphaned, identity unknown
	// => classifyForDeletion refuses (not a terminal state).
	await fs.writeFile(
		path.join(runDir, "status.json"),
		JSON.stringify({ jobId, state: "running", pid: process.pid, updatedAt: new Date().toISOString() }, null, 2),
	);
	const ctx = makeCtx({ cwd, trusted: true });
	await commands.get("bg").handler(`delete ${jobId}`, ctx);
	const msg = ctx._notes.at(-1)?.msg || "";
	check("delete-live: refuses with `cannot be deleted`", /cannot be deleted/.test(msg), msg);
	check("delete-live: the run dir is left intact", existsSync(runDir), runDir);
	check("delete-live: current process is still alive (never touched)", process.kill(process.pid, 0));
}

// ── Gap 6: handlePrune untrusted + plan-mode gates ───────────────────────────
async function pruneUntrustedAndPlanModeRejected(url) {
	const { commands } = await loadExtension(url);

	// Untrusted project: prune is refused with a trust message.
	const untrustedCwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-prune-untrusted-"));
	const untrustedCtx = makeCtx({ cwd: untrustedCwd, trusted: false });
	await commands.get("bg").handler("prune", untrustedCtx);
	const untrustedMsg = untrustedCtx._notes.at(-1)?.msg || "";
	check(
		"prune-gate: untrusted project is rejected",
		/Cannot \/bg prune in an untrusted project/.test(untrustedMsg),
		untrustedMsg,
	);
	check("prune-gate: untrusted rejection uses 'warning' type", untrustedCtx._notes.at(-1)?.type === "warning");

	// Plan mode active: prune is refused before the trust check.
	const planSym = Symbol.for("pi-dynamic-workflows.plan-mode.guard");
	const prev = globalThis[planSym];
	globalThis[planSym] = { isActive: () => true };
	try {
		const planCwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-prune-plan-"));
		const planCtx = makeCtx({ cwd: planCwd, trusted: true });
		await commands.get("bg").handler("prune", planCtx);
		const planMsg = planCtx._notes.at(-1)?.msg || "";
		check("prune-gate: plan mode active is rejected", /Cannot \/bg prune while plan mode/.test(planMsg), planMsg);
		check("prune-gate: plan-mode rejection uses 'warning' type", planCtx._notes.at(-1)?.type === "warning");
	} finally {
		if (prev === undefined) delete globalThis[planSym];
		else globalThis[planSym] = prev;
	}
}

// ── Gap 7: reconcileInterruptedJobs skips jobs active in this session ─────────
async function reconcileSkipsActiveSessionJob(url) {
	// IMPORTANT: load ONE module instance so the command handler and reconcile share
	// the same in-process activeJobs registry (separate cache-busted imports would each
	// get their own activeJobs and the "active" guard could not be observed).
	const mod = await loadModule(url);
	const reconcile = mod.reconcileInterruptedJobs;
	const { pi, commands } = makePi();
	mod.default(pi);
	check("reconcile-active: reconcileInterruptedJobs is exported", typeof reconcile === "function", typeof reconcile);
	if (typeof reconcile !== "function") return;

	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-reconcile-active-"));
	const job = await startLongJob(commands, cwd);
	try {
		// Tamper this live, in-session job's status to look like a dead-pid running job.
		const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
		const statusFile = path.join(job.runDir, "status.json");
		const current = await readJson(statusFile);
		await fs.writeFile(
			statusFile,
			JSON.stringify({ ...current, state: "running", pid: dead.pid, startId: undefined }, null, 2),
		);
		const n = await reconcile(job.ctx);
		check("reconcile-active: reconcile rewrites nothing (active job skipped)", n === 0, String(n));
		const after = await readJson(statusFile);
		check(
			"reconcile-active: the active job's state is NOT rewritten to interrupted",
			after.state === "running",
			JSON.stringify(after),
		);
	} finally {
		await job.cleanup();
		await waitFor(
			"reconcile-active job terminal",
			async () => ["cancelled", "completed", "failed"].includes((await readJson(path.join(job.runDir, "status.json"))).state),
			{ timeoutMs: 8000 },
		).catch(() => {});
	}
}

async function main() {
	const { url } = await buildBg();
	await topLevelCatchReturnsErrorResponse(url);
	await duplicateCancelIsReported(url);
	await cancelPersistedRefusesReusedIdentity(url);
	await deleteRefusesLiveOrphan(url);
	await pruneUntrustedAndPlanModeRejected(url);
	await reconcileSkipsActiveSessionJob(url);

	// Intentionally not covered:
	skipped.push(
		"handleCancel already-finished in-session branch (isJobFinished true while still in activeJobs): the window between child exit (exitCode set) and the 'close' handler running safeFinalize (which deletes the runtime from activeJobs) is not deterministically observable from the command handler, so a non-racy assertion is impossible.",
	);

	console.log(`${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		console.log("Failures:\n" + counts.failures.map((f) => `  - ${f}`).join("\n"));
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
