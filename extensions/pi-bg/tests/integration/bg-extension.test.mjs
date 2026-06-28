#!/usr/bin/env node
/**
 * Durable behavioral integration test for `/bg` safety/read paths.
 *
 * This pins the safety-critical M2 contract:
 * - `/bg plan` is a dry-run only and creates no runtime artifacts.
 * - `/bg list/status/logs` read trusted project-local and global fallback artifacts safely.
 * - mutating start/cancel slash commands are blocked in plan mode.
 * - untrusted projects do not inspect project-local `.pi/bg` artifacts and cannot start jobs.
 * - log output is bounded/truncated and job ids cannot path-traverse.
 */

import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

let passed = 0;
let failed = 0;
const failures = [];
function check(label, cond, detail) {
	if (cond) {
		passed += 1;
		console.log(`PASS: ${label}`);
	} else {
		failed += 1;
		failures.push(label + (detail ? `  [${detail}]` : ""));
		console.log(`FAIL: ${label}${detail ? `  [${detail}]` : ""}`);
	}
}

function stableHash(value) {
	return crypto.createHash("sha1").update(value).digest("hex").slice(0, 12);
}

async function buildBg() {
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-integration-"));
	const sdkStub = path.join(outDir, "stub-sdk.mjs");
	await fs.writeFile(
		sdkStub,
		`export const CONFIG_DIR_NAME = ".pi";\nexport function getAgentDir() { return ${JSON.stringify(path.join(outDir, "agentdir"))}; }\n`,
	);
	const typeboxStub = path.join(outDir, "stub-typebox.mjs");
	await fs.writeFile(
		typeboxStub,
		"const id = (x) => x ?? {};\nexport const Type = { Object: id, Number: id, String: id, Boolean: id, Array: id, Optional: id, Union: id, Literal: id, Any: id };\nexport default { Type };\n",
	);

	const planSrc = path.join(REPO_ROOT, "extensions", "pi-plan", "index.ts");
	if (!existsSync(planSrc)) throw new Error(`missing source: ${planSrc}`);
	const planOut = path.join(outDir, "plan.mjs");
	const planBuild = spawnSync(
		"npx",
		[
			"--no-install",
			"esbuild",
			planSrc,
			"--bundle",
			"--platform=node",
			"--format=esm",
			`--alias:typebox=${typeboxStub}`,
			`--alias:@earendil-works/pi-coding-agent=${sdkStub}`,
			`--outfile=${planOut}`,
		],
		{ cwd: REPO_ROOT, encoding: "utf8" },
	);
	if (planBuild.status !== 0) throw new Error(`esbuild failed for plan: ${planBuild.stderr || planBuild.stdout}`);

	const src = path.join(REPO_ROOT, "extensions", "pi-bg", "index.ts");
	if (!existsSync(src)) throw new Error(`missing source: ${src}`);
	const out = path.join(outDir, "bg.mjs");
	const r = spawnSync(
		"npx",
		[
			"--no-install",
			"esbuild",
			src,
			"--bundle",
			"--platform=node",
			"--format=esm",
			`--alias:@earendil-works/pi-coding-agent=${sdkStub}`,
			`--outfile=${out}`,
		],
		{ cwd: REPO_ROOT, encoding: "utf8" },
	);
	if (r.status !== 0) throw new Error(`esbuild failed for bg: ${r.stderr || r.stdout}`);
	return { outDir, url: pathToFileURL(out).href, planUrl: pathToFileURL(planOut).href, agentDir: path.join(outDir, "agentdir") };
}

let instance = 0;
async function freshDefault(url) {
	const mod = await import(`${url}?i=${instance++}`);
	return mod.default;
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

async function setupJob(runsDir, jobId, { command = "echo hi", state = "completed", updatedAt = "2026-06-25T00:00:00.000Z", log } = {}) {
	const runDir = path.join(runsDir, jobId);
	await fs.mkdir(runDir, { recursive: true });
	await fs.writeFile(
		path.join(runDir, "job.json"),
		JSON.stringify({ jobId, command, cwd: "/tmp/project", createdAt: updatedAt, source: "slash", artifactsDir: runDir }, null, 2),
	);
	await fs.writeFile(path.join(runDir, "status.json"), JSON.stringify({ jobId, state, updatedAt }, null, 2));
	if (log !== undefined) await fs.writeFile(path.join(runDir, "combined.log"), log);
	return runDir;
}

async function loadExtension(url) {
	const extension = await freshDefault(url);
	const { pi, commands, tools } = makePi();
	extension(pi);
	return { commands, tools };
}

async function loadPlanAndBg(planUrl, bgUrl) {
	const planExtension = await freshDefault(planUrl);
	const bgExtension = await freshDefault(bgUrl);
	const { pi, commands, tools } = makePi();
	planExtension(pi);
	bgExtension(pi);
	return { commands, tools };
}

async function dryRunHasNoRuntimeWrites(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-project-"));
	const { commands, tools } = await loadExtension(url);
	const ctx = makeCtx({ cwd, trusted: true });
	await commands.get("bg").handler("plan npm test", ctx);

	check("dry-run: registers /bg command", commands.has("bg"));
	check("dry-run: registers no LLM tools", tools.size === 0, `registered tools: ${[...tools.keys()].join(",")}`);
	check("dry-run: reports no job started", /Dry run only/.test(ctx._notes.at(-1)?.msg || ""));
	check("dry-run: includes planned command", /npm test/.test(ctx._notes.at(-1)?.msg || ""));
	check("dry-run: creates no project .pi artifacts", !existsSync(path.join(cwd, ".pi")));
}

async function startCancelRejectInPlanMode(planUrl, bgUrl) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-plan-guard-"));
	const { commands, tools } = await loadPlanAndBg(planUrl, bgUrl);
	const ctx = makeCtx({ cwd, trusted: true });

	await commands.get("plan").handler("design safely", ctx);
	// A later same-process plan.ts load must not mask an already-active plan guard.
	const reloadedPlanExtension = await freshDefault(planUrl);
	reloadedPlanExtension(makePi().pi);
	await commands.get("bg").handler("start npm test", ctx);
	const startMsg = ctx._notes.at(-1)?.msg || "";
	check("plan guard: /bg start rejected while plan mode active", /Cannot \/bg start while plan mode is active/.test(startMsg));
	check("plan guard: /bg start creates no project artifacts", !existsSync(path.join(cwd, ".pi")));

	await commands.get("bg").handler("cancel job-1", ctx);
	const cancelMsg = ctx._notes.at(-1)?.msg || "";
	check("plan guard: /bg cancel rejected while plan mode active", /Cannot \/bg cancel while plan mode is active/.test(cancelMsg));
	check("plan guard: still registers no background_job\/bg LLM tools", tools.size === 1 && tools.has("submit_plan"), `registered tools: ${[...tools.keys()].join(",")}`);

	await commands.get("plan").handler("exit", ctx);
}

async function listStatusLogsReadExistingArtifacts(url, agentDir) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-project-"));
	const projectRunsRoot = path.join(cwd, ".pi", "bg", "runs");
	const globalRunsRoot = path.join(agentDir, "bg", "runs", stableHash(cwd));
	await setupJob(projectRunsRoot, "project-job", { command: "project cmd", state: "running", updatedAt: "2026-06-25T02:00:00.000Z" });
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
	check("logs: truncates oversized combined.log", logsMsg.startsWith("[truncated to last 20000 bytes]"));
	check("logs: keeps tail of oversized combined.log", logsMsg.includes("TAIL"));
	check("logs: drops old head of oversized combined.log", !logsMsg.includes("BEGIN"));
	check("logs: output remains bounded", logsMsg.length <= 20_080, `length=${logsMsg.length}`);
}

async function logTailDoesNotSplitUtf8(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-utf8-"));
	const runsRoot = path.join(cwd, ".pi", "bg", "runs");
	// Place a 4-byte emoji so the last-20000-bytes window starts on a continuation byte.
	const head = Buffer.from("A".repeat(10));
	const emoji = Buffer.from("\u{1F600}");
	const tail = Buffer.from("A".repeat(19997));
	const logBuf = Buffer.concat([head, emoji, tail]);
	await setupJob(runsRoot, "utf8-job", { command: "x", state: "completed", log: logBuf });

	const { commands } = await loadExtension(url);
	const ctx = makeCtx({ cwd, trusted: true });
	await commands.get("bg").handler("logs utf8-job", ctx);
	const msg = ctx._notes.at(-1)?.msg || "";
	check("utf8: oversized log is truncated", msg.startsWith("[truncated to last 20000 bytes]"), msg.slice(0, 40));
	check("utf8: tail read does not emit a replacement char", !msg.includes("\uFFFD"), JSON.stringify(msg.slice(0, 40)));
}

async function emptyAndUntrustedBehavior(url, agentDir) {
	const emptyCwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-empty-"));
	let loaded = await loadExtension(url);
	let ctx = makeCtx({ cwd: emptyCwd, trusted: true });
	await loaded.commands.get("bg").handler("list", ctx);
	check("empty: missing artifact roots returns empty list", /No background jobs found/.test(ctx._notes.at(-1)?.msg || ""));

	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-untrusted-"));
	const projectRunsRoot = path.join(cwd, ".pi", "bg", "runs");
	const globalRunsRoot = path.join(agentDir, "bg", "runs", stableHash(cwd));
	await setupJob(projectRunsRoot, "project-only", { command: "must not be read", state: "running" });
	await setupJob(globalRunsRoot, "global-only", { command: "safe global", state: "completed" });

	loaded = await loadExtension(url);
	ctx = makeCtx({ cwd, trusted: false });
	await loaded.commands.get("bg").handler("list", ctx);
	const listMsg = ctx._notes.at(-1)?.msg || "";
	check("untrusted: does not inspect project-local .pi/bg", !/project-only/.test(listMsg));
	check("untrusted: still inspects global fallback", /global-only/.test(listMsg));

	await loaded.commands.get("bg").handler("status project-only", ctx);
	check("untrusted: project-local status is not found", /not found/.test(ctx._notes.at(-1)?.msg || ""));

	await loaded.commands.get("bg").handler("status ..", ctx);
	check("security: path traversal job id is rejected", /Usage: \/bg status/.test(ctx._notes.at(-1)?.msg || ""));

	const startCwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-untrusted-start-"));
	ctx = makeCtx({ cwd: startCwd, trusted: false });
	await loaded.commands.get("bg").handler("start npm test", ctx);
	check("untrusted: /bg start is rejected", /Cannot \/bg start in an untrusted project/.test(ctx._notes.at(-1)?.msg || ""));
	check("untrusted: /bg start creates no project artifacts", !existsSync(path.join(startCwd, ".pi")));
}

async function symlinkedRunDirsAreRejected(url, agentDir) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-symlink-"));
	const globalRunsRoot = path.join(agentDir, "bg", "runs", stableHash(cwd));
	const projectRunsRoot = path.join(cwd, ".pi", "bg", "runs");
	const outsideRunsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-outside-"));
	const outsideRunDir = await setupJob(outsideRunsRoot, "outside", { command: "outside secret", state: "completed", log: "outside log" });
	for (const runsRoot of [globalRunsRoot, projectRunsRoot]) {
		await fs.mkdir(runsRoot, { recursive: true });
		await fs.symlink(outsideRunDir, path.join(runsRoot, "linked-job"), "dir");
	}

	let loaded = await loadExtension(url);
	let ctx = makeCtx({ cwd, trusted: false });
	await loaded.commands.get("bg").handler("list", ctx);
	check("security: global list ignores symlinked run dirs", !/linked-job|outside secret/.test(ctx._notes.at(-1)?.msg || ""));

	await loaded.commands.get("bg").handler("status linked-job", ctx);
	check("security: global status rejects symlinked run dirs", /not found/.test(ctx._notes.at(-1)?.msg || ""));

	await loaded.commands.get("bg").handler("logs linked-job", ctx);
	check("security: global logs rejects symlinked run dirs", /not found/.test(ctx._notes.at(-1)?.msg || ""));

	loaded = await loadExtension(url);
	ctx = makeCtx({ cwd, trusted: true });
	await loaded.commands.get("bg").handler("list", ctx);
	check("security: project list ignores symlinked run dirs", !/linked-job|outside secret/.test(ctx._notes.at(-1)?.msg || ""));

	await loaded.commands.get("bg").handler("status linked-job", ctx);
	check("security: project status rejects symlinked run dirs", /not found/.test(ctx._notes.at(-1)?.msg || ""));

	await loaded.commands.get("bg").handler("logs linked-job", ctx);
	check("security: project logs rejects symlinked run dirs", /not found/.test(ctx._notes.at(-1)?.msg || ""));
}

async function symlinkedArtifactRootsAreIgnored(url, agentDir) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-rootlink-"));
	const outsideRunsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-rootlink-outside-"));
	await setupJob(outsideRunsRoot, "root-link-job", { command: "outside root secret", state: "completed", log: "outside root log" });

	const projectRunsParent = path.join(cwd, ".pi", "bg");
	await fs.mkdir(projectRunsParent, { recursive: true });
	await fs.symlink(outsideRunsRoot, path.join(projectRunsParent, "runs"), "dir");

	let loaded = await loadExtension(url);
	let ctx = makeCtx({ cwd, trusted: true });
	await loaded.commands.get("bg").handler("list", ctx);
	check("security: project list ignores symlinked artifact root", !/root-link-job|outside root secret/.test(ctx._notes.at(-1)?.msg || ""));
	await loaded.commands.get("bg").handler("status root-link-job", ctx);
	check("security: project status rejects symlinked artifact root", /not found/.test(ctx._notes.at(-1)?.msg || ""));
	await loaded.commands.get("bg").handler("logs root-link-job", ctx);
	check("security: project logs rejects symlinked artifact root", /not found/.test(ctx._notes.at(-1)?.msg || ""));

	const globalRunsParent = path.join(agentDir, "bg", "runs");
	await fs.mkdir(globalRunsParent, { recursive: true });
	await fs.symlink(outsideRunsRoot, path.join(globalRunsParent, stableHash(cwd)), "dir");

	loaded = await loadExtension(url);
	ctx = makeCtx({ cwd, trusted: false });
	await loaded.commands.get("bg").handler("list", ctx);
	check("security: global list ignores symlinked artifact root", !/root-link-job|outside root secret/.test(ctx._notes.at(-1)?.msg || ""));
	await loaded.commands.get("bg").handler("status root-link-job", ctx);
	check("security: global status rejects symlinked artifact root", /not found/.test(ctx._notes.at(-1)?.msg || ""));
	await loaded.commands.get("bg").handler("logs root-link-job", ctx);
	check("security: global logs rejects symlinked artifact root", /not found/.test(ctx._notes.at(-1)?.msg || ""));
}

async function symlinkedArtifactFilesAreIgnored(url, agentDir) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-filelink-"));
	const runDir = path.join(agentDir, "bg", "runs", stableHash(cwd), "file-link-job");
	await fs.mkdir(runDir, { recursive: true });
	const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-filelink-outside-"));
	const outsideJob = path.join(outsideDir, "job.json");
	const outsideLog = path.join(outsideDir, "combined.log");
	await fs.writeFile(outsideJob, JSON.stringify({ jobId: "file-link-job", command: "outside secret" }));
	await fs.writeFile(outsideLog, "outside log secret");
	await fs.symlink(outsideJob, path.join(runDir, "job.json"));
	await fs.writeFile(path.join(runDir, "status.json"), JSON.stringify({ jobId: "file-link-job", state: "completed", updatedAt: "2026-06-25T00:00:00.000Z" }));
	await fs.symlink(outsideLog, path.join(runDir, "combined.log"));

	const { commands } = await loadExtension(url);
	const ctx = makeCtx({ cwd, trusted: false });
	await commands.get("bg").handler("status file-link-job", ctx);
	check("security: status ignores symlinked job.json files", !/outside secret/.test(ctx._notes.at(-1)?.msg || ""));

	await commands.get("bg").handler("logs file-link-job", ctx);
	check("security: logs ignores symlinked log files", /No logs found/.test(ctx._notes.at(-1)?.msg || "") && !/outside log secret/.test(ctx._notes.at(-1)?.msg || ""));
}

async function corruptArtifactsAreTolerated(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-corrupt-"));
	const runDir = path.join(cwd, ".pi", "bg", "runs", "corrupt-job");
	await fs.mkdir(runDir, { recursive: true });
	await fs.writeFile(path.join(runDir, "job.json"), "{not-json");
	await fs.writeFile(path.join(runDir, "status.json"), "{not-json");
	await fs.writeFile(path.join(runDir, ".status.json.tmp"), "partial");

	const { commands } = await loadExtension(url);
	const ctx = makeCtx({ cwd, trusted: true });
	await commands.get("bg").handler("list", ctx);
	check("corrupt: list does not crash and shows unknown job", /corrupt-job: unknown/.test(ctx._notes.at(-1)?.msg || ""), ctx._notes.at(-1)?.msg);

	await commands.get("bg").handler("status corrupt-job", ctx);
	check("corrupt: status does not crash", /"jobId": "corrupt-job"/.test(ctx._notes.at(-1)?.msg || ""), ctx._notes.at(-1)?.msg);

	await commands.get("bg").handler("logs corrupt-job", ctx);
	check("corrupt: missing logs are reported safely", /No logs found/.test(ctx._notes.at(-1)?.msg || ""), ctx._notes.at(-1)?.msg);
}

async function main() {
	const { url, planUrl, agentDir } = await buildBg();
	await dryRunHasNoRuntimeWrites(url);
	await startCancelRejectInPlanMode(planUrl, url);
	await listStatusLogsReadExistingArtifacts(url, agentDir);
	await logTailDoesNotSplitUtf8(url);
	await emptyAndUntrustedBehavior(url, agentDir);
	await symlinkedRunDirsAreRejected(url, agentDir);
	await symlinkedArtifactRootsAreIgnored(url, agentDir);
	await symlinkedArtifactFilesAreIgnored(url, agentDir);
	await corruptArtifactsAreTolerated(url);

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed) {
		console.error(failures.join("\n"));
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(2);
});
