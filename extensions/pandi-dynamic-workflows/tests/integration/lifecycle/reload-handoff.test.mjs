#!/usr/bin/env node
/**
 * Regresión: los dynamic workflows de background sobreviven a `/reload` interrumpiendo
 * el intento viejo in-process y auto-reanudando el mismo runId en la instancia fresca
 * de la extensión. Las llamadas cacheadas completadas no deben re-ejecutarse, y el ctx
 * stale pre-reload no debe emitir el wake-up esperado de falla por interrupción de reload.
 *
 * Ejecutalo:
 *   node extensions/pandi-dynamic-workflows/tests/integration/lifecycle/reload-handoff.test.mjs
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const { check, counts } = createChecker();

const BARRIER_STARTED = "barrier-started";
const BARRIER_RELEASE = "barrier-release";

const WORKFLOW = `
export const meta = { name: "reload-probe", description: "reload handoff probe" };
const barrierStarted = runDir + "/${BARRIER_STARTED}";
const barrierRelease = runDir + "/${BARRIER_RELEASE}";
const first = await bash("printf first", { cache: true });
await log("after cached bash");
await writeFile(barrierStarted, "started");
while (true) {
	try {
		await readFile(barrierRelease);
		break;
	} catch {
		await sleep(20);
	}
}
return { runId, first: first.stdout };
`;

async function buildExtension() {
	return await sharedBuildExtension({
		name: "pi-dw-reload-handoff",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "index.ts"),
		outName: "dynamic-workflows.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
	});
}

async function buildLifecycleModule() {
	return await sharedBuildExtension({
		name: "pi-dw-reload-lifecycle",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "lifecycle", "index.ts"),
		outName: "lifecycle.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
	});
}

let importCounter = 0;
async function loadExtensionModule(url) {
	return await import(`${url}?reload=${importCounter++}`);
}

function makePi(label, sharedExecCalls = []) {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const shortcuts = [];
	const activeTools = [];
	const userMessages = [];
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: (name, opts) => commands.set(name, opts),
		registerShortcut: (key, opts) => shortcuts.push({ key, opts }),
		on: (event, handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		appendEntry: () => {},
		sendUserMessage: (message, options) => userMessages.push({ label, message, options }),
		getThinkingLevel: () => undefined,
		getActiveTools: () => activeTools,
		getAllTools: () => [...tools.values()],
		setActiveTools: (next) => {
			activeTools.splice(0, activeTools.length, ...next);
		},
		exec: async (cmd, args, opts) => {
			const call = { label, cmd, args, opts, index: sharedExecCalls.length + 1 };
			sharedExecCalls.push(call);
			return { code: 0, killed: false, stdout: `exec-${call.index}`, stderr: "" };
		},
	};
	return { pi, tools, commands, handlers, shortcuts, activeTools, userMessages, execCalls: sharedExecCalls };
}

function bashExecCalls(calls) {
	return calls.filter((call) => call.cmd === "bash");
}

function makeCtx(cwd, label) {
	const notifications = [];
	const statuses = [];
	const widgets = [];
	const theme = {
		fg: (_color, value) => value,
		bold: (value) => value,
	};
	return {
		ctx: {
			mode: "tui",
			hasUI: true,
			cwd,
			isIdle: () => true,
			isProjectTrusted: () => true,
			getContextUsage: () => undefined,
			ui: {
				theme,
				notify: (message, type) => notifications.push({ label, message, type }),
				setStatus: (key, value) => statuses.push({ key, value }),
				setWidget: (key, value, options) => widgets.push({ key, value, options }),
				confirm: async () => true,
				select: async () => undefined,
				editor: async (_title, initial = "") => initial,
				custom: async () => undefined,
				getEditorComponent: () => undefined,
				setEditorComponent: () => {},
			},
			sessionManager: {
				getEntries: () => [],
				getBranch: () => [],
				getSessionId: () => `${label}-session`,
				getSessionFile: () => path.join(cwd, `${label}.jsonl`),
				getSessionName: () => label,
			},
		},
		notifications,
		statuses,
		widgets,
	};
}

async function emit(handlers, eventName, event, ctx) {
	for (const handler of handlers.get(eventName) ?? []) await handler(event, ctx);
}

async function makeProject() {
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-reload-project-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	await fs.writeFile(path.join(project, ".pi", "workflows", "reload-probe.js"), `${WORKFLOW}\n`, "utf8");
	return project;
}

async function runTool(tool, ctx, params) {
	return await tool.execute("tc-reload", params, new AbortController().signal, undefined, ctx);
}

async function readJsonIfExists(file) {
	try {
		return JSON.parse(await fs.readFile(file, "utf8"));
	} catch {
		return undefined;
	}
}

async function waitFor(label, fn, timeoutMs = 8000) {
	const start = Date.now();
	let last;
	while (Date.now() - start < timeoutMs) {
		try {
			last = await fn();
			if (last) return last;
		} catch (err) {
			last = err instanceof Error ? err.message : String(err);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
}

async function fileExists(file) {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

function barrierPath(runDir, name) {
	return path.join(runDir, name);
}

async function waitForBarrierStarted(runDir) {
	return await waitFor("workflow barrier", async () => await fileExists(barrierPath(runDir, BARRIER_STARTED)), 4000);
}

async function releaseBarrier(runDir) {
	await fs.writeFile(barrierPath(runDir, BARRIER_RELEASE), "release", "utf8");
}

function hasReloadHandoff(runId) {
	const store = globalThis.__pandiDynamicWorkflowsReloadHandoff;
	return store instanceof Map && store.has(runId);
}

async function waitForCompletedResult(runDir) {
	return await waitFor(
		"completed result",
		async () => {
			const result = await readJsonIfExists(path.join(runDir, "result.json"));
			return result?.state === "completed" ? result : undefined;
		},
		10000,
	);
}

async function scenarioReloadAutoResume(url) {
	const project = await makeProject();
	const sharedExecCalls = [];

	const firstMod = await loadExtensionModule(url);
	const firstExt = firstMod.default;
	const firstPi = makePi("before-reload", sharedExecCalls);
	const firstCtx = makeCtx(project, "before-reload");
	firstExt(firstPi.pi);
	await emit(firstPi.handlers, "session_start", { reason: "startup" }, firstCtx.ctx);

	const startResponse = await runTool(firstPi.tools.get("dynamic_workflow"), firstCtx.ctx, {
		action: "start",
		name: "reload-probe",
		concurrency: 1,
		maxAgents: 2,
		timeoutMs: 30_000,
		agentTimeoutMs: 30_000,
	});
	const status = startResponse.details.status;
	check(
		"reload: initial start returns a running background status",
		status?.state === "running",
		JSON.stringify(status),
	);
	await waitForBarrierStarted(status.runDir);
	check(
		"reload: first attempt executed cached bash once",
		bashExecCalls(sharedExecCalls).length === 1,
		JSON.stringify(sharedExecCalls),
	);

	await emit(firstPi.handlers, "session_shutdown", { reason: "reload" }, firstCtx.ctx);
	const interrupted = await readJsonIfExists(path.join(status.runDir, "result.json"));
	check(
		"reload: old attempt is interrupted as a resumable failure",
		interrupted?.state === "failed" && /reload/i.test(interrupted.error || ""),
		JSON.stringify(interrupted),
	);
	check(
		"reload: old ctx did not notify the expected reload-interrupt failure",
		firstCtx.notifications.length === 0 && firstPi.userMessages.length === 0,
		JSON.stringify({ notifications: firstCtx.notifications, userMessages: firstPi.userMessages }),
	);
	await releaseBarrier(status.runDir);

	const secondMod = await loadExtensionModule(url);
	const secondExt = secondMod.default;
	const secondPi = makePi("after-reload", sharedExecCalls);
	const secondCtx = makeCtx(project, "after-reload");
	secondExt(secondPi.pi);
	await emit(secondPi.handlers, "session_start", { reason: "reload" }, secondCtx.ctx);

	const completed = await waitForCompletedResult(status.runDir);
	check("reload: auto-resume completes the same runId", completed.runId === status.runId, JSON.stringify(completed));
	check(
		"reload: cached bash was not re-executed after reload",
		bashExecCalls(sharedExecCalls).length === 1,
		JSON.stringify(sharedExecCalls),
	);
	check(
		"reload: final output comes from the cached first bash",
		completed.output?.first === "exec-1",
		JSON.stringify(completed.output),
	);
	check(
		"reload: original run limits are preserved after auto-resume",
		completed.agentConcurrency === 1 && completed.maxAgents === 2,
		JSON.stringify({ agentConcurrency: completed.agentConcurrency, maxAgents: completed.maxAgents }),
	);
	await waitFor(
		"reload completion notification",
		async () =>
			secondCtx.notifications.some((n) => /completed/i.test(n.message)) && secondPi.userMessages.length === 1,
	);
	check(
		"reload: fresh ctx receives the normal completion notification",
		secondCtx.notifications.some((n) => /completed/i.test(n.message)) && secondPi.userMessages.length === 1,
		JSON.stringify({ notifications: secondCtx.notifications, userMessages: secondPi.userMessages }),
	);

	await emit(secondPi.handlers, "session_shutdown", { reason: "quit" }, secondCtx.ctx);
}

async function scenarioMultipleReloadAutoResume(url) {
	const project = await makeProject();
	const sharedExecCalls = [];

	const firstMod = await loadExtensionModule(url);
	const firstExt = firstMod.default;
	const firstPi = makePi("multi-before", sharedExecCalls);
	const firstCtx = makeCtx(project, "multi-before");
	firstExt(firstPi.pi);
	await emit(firstPi.handlers, "session_start", { reason: "startup" }, firstCtx.ctx);

	const firstStart = await runTool(firstPi.tools.get("dynamic_workflow"), firstCtx.ctx, {
		action: "start",
		name: "reload-probe",
		concurrency: 1,
		maxAgents: 2,
		timeoutMs: 30_000,
	});
	const secondStart = await runTool(firstPi.tools.get("dynamic_workflow"), firstCtx.ctx, {
		action: "start",
		name: "reload-probe",
		concurrency: 1,
		maxAgents: 2,
		timeoutMs: 30_000,
	});
	const firstStatus = firstStart.details.status;
	const secondStatus = secondStart.details.status;
	await Promise.all([waitForBarrierStarted(firstStatus.runDir), waitForBarrierStarted(secondStatus.runDir)]);
	check(
		"multi: both old attempts reached their cached bash before reload",
		bashExecCalls(sharedExecCalls).length === 2,
		JSON.stringify(sharedExecCalls),
	);

	await emit(firstPi.handlers, "session_shutdown", { reason: "reload" }, firstCtx.ctx);
	const interrupted = await Promise.all([
		readJsonIfExists(path.join(firstStatus.runDir, "result.json")),
		readJsonIfExists(path.join(secondStatus.runDir, "result.json")),
	]);
	check(
		"multi: both old attempts are interrupted as reload failures",
		interrupted.every((result) => result?.state === "failed" && /reload/i.test(result.error || "")),
		JSON.stringify(interrupted),
	);
	await Promise.all([releaseBarrier(firstStatus.runDir), releaseBarrier(secondStatus.runDir)]);

	const secondMod = await loadExtensionModule(url);
	const secondExt = secondMod.default;
	const secondPi = makePi("multi-after", sharedExecCalls);
	const secondCtx = makeCtx(project, "multi-after");
	secondExt(secondPi.pi);
	await emit(secondPi.handlers, "session_start", { reason: "reload" }, secondCtx.ctx);

	const completed = await Promise.all([
		waitForCompletedResult(firstStatus.runDir),
		waitForCompletedResult(secondStatus.runDir),
	]);
	check(
		"multi: all reload handoff runs resume with the same runIds",
		completed[0].runId === firstStatus.runId && completed[1].runId === secondStatus.runId,
		JSON.stringify(completed.map((result) => result.runId)),
	);
	check(
		"multi: cached bash calls are not re-executed for either resumed run",
		bashExecCalls(sharedExecCalls).length === 2,
		JSON.stringify(sharedExecCalls),
	);
	await emit(secondPi.handlers, "session_shutdown", { reason: "quit" }, secondCtx.ctx);
}

async function scenarioReloadHandoffRequiresReloadStartAndMatchingCwd(url) {
	const project = await makeProject();
	const otherProject = await makeProject();
	const sharedExecCalls = [];

	const firstMod = await loadExtensionModule(url);
	const firstExt = firstMod.default;
	const firstPi = makePi("cwd-before", sharedExecCalls);
	const firstCtx = makeCtx(project, "cwd-before");
	firstExt(firstPi.pi);
	await emit(firstPi.handlers, "session_start", { reason: "startup" }, firstCtx.ctx);

	const startResponse = await runTool(firstPi.tools.get("dynamic_workflow"), firstCtx.ctx, {
		action: "start",
		name: "reload-probe",
		timeoutMs: 30_000,
	});
	const status = startResponse.details.status;
	await waitForBarrierStarted(status.runDir);
	await emit(firstPi.handlers, "session_shutdown", { reason: "reload" }, firstCtx.ctx);
	const interrupted = await readJsonIfExists(path.join(status.runDir, "result.json"));
	check(
		"cwd: old attempt is queued as a reload interruption",
		interrupted?.state === "failed" && /reload/i.test(interrupted.error || ""),
		JSON.stringify(interrupted),
	);

	const wrongCwdMod = await loadExtensionModule(url);
	const wrongCwdExt = wrongCwdMod.default;
	const wrongCwdPi = makePi("cwd-wrong", sharedExecCalls);
	const wrongCwdCtx = makeCtx(otherProject, "cwd-wrong");
	wrongCwdExt(wrongCwdPi.pi);
	await emit(wrongCwdPi.handlers, "session_start", { reason: "reload" }, wrongCwdCtx.ctx);
	const afterWrongCwd = await readJsonIfExists(path.join(status.runDir, "result.json"));
	check(
		"cwd: reload handoff is not resumed from a different cwd",
		afterWrongCwd?.state === "failed" &&
			bashExecCalls(sharedExecCalls).length === 1 &&
			hasReloadHandoff(status.runId),
		JSON.stringify({ afterWrongCwd, execCalls: sharedExecCalls, hasHandoff: hasReloadHandoff(status.runId) }),
	);
	await emit(wrongCwdPi.handlers, "session_shutdown", { reason: "quit" }, wrongCwdCtx.ctx);

	const startupMod = await loadExtensionModule(url);
	const startupExt = startupMod.default;
	const startupPi = makePi("cwd-startup", sharedExecCalls);
	const startupCtx = makeCtx(project, "cwd-startup");
	startupExt(startupPi.pi);
	await emit(startupPi.handlers, "session_start", { reason: "startup" }, startupCtx.ctx);
	const afterStartup = await readJsonIfExists(path.join(status.runDir, "result.json"));
	check(
		"cwd: non-reload session_start does not consume a valid handoff",
		afterStartup?.state === "failed" && bashExecCalls(sharedExecCalls).length === 1 && hasReloadHandoff(status.runId),
		JSON.stringify({ afterStartup, execCalls: sharedExecCalls, hasHandoff: hasReloadHandoff(status.runId) }),
	);
	await emit(startupPi.handlers, "session_shutdown", { reason: "quit" }, startupCtx.ctx);
	await releaseBarrier(status.runDir);

	const reloadMod = await loadExtensionModule(url);
	const reloadExt = reloadMod.default;
	const reloadPi = makePi("cwd-reload", sharedExecCalls);
	const reloadCtx = makeCtx(project, "cwd-reload");
	reloadExt(reloadPi.pi);
	await emit(reloadPi.handlers, "session_start", { reason: "reload" }, reloadCtx.ctx);
	const completed = await waitForCompletedResult(status.runDir);
	check(
		"cwd: matching cwd plus reload reason resumes the preserved handoff",
		completed.runId === status.runId && bashExecCalls(sharedExecCalls).length === 1,
		JSON.stringify({ completed, execCalls: sharedExecCalls }),
	);
	await emit(reloadPi.handlers, "session_shutdown", { reason: "quit" }, reloadCtx.ctx);
}

async function scenarioCompletedDuringReloadHandoffNotifiesFreshSession(lifecycleUrl) {
	const project = await makeProject();
	const runId = "2026-01-01T00-00-00-000Z-completed-during-reload";
	const runDir = path.join(project, ".pi", "workflows", "runs", runId);
	const result = {
		workflow: "reload-probe",
		scope: "project",
		file: path.join(project, ".pi", "workflows", "reload-probe.js"),
		runId,
		runDir,
		ok: true,
		state: "completed",
		background: true,
		startedAt: "2026-01-01T00:00:00.000Z",
		endedAt: "2026-01-01T00:00:01.000Z",
		elapsedMs: 1000,
		agentCount: 0,
		agentConcurrency: 1,
		maxAgents: 1,
		parallelAgents: 0,
		peakParallelAgents: 0,
		logs: [],
		output: { ok: true },
	};
	globalThis.__pandiDynamicWorkflowsReloadHandoff = new Map([
		[
			runId,
			{
				runId,
				cwd: project,
				limits: { concurrency: 1, maxAgents: 1, timeoutMs: 30_000, agentTimeoutMs: 30_000 },
				settled: Promise.resolve(result),
			},
		],
	]);

	const lifecycle = await import(`${lifecycleUrl}?completed-handoff`);
	const piState = makePi("completed-after-reload");
	const ctxState = makeCtx(project, "completed-after-reload");
	const handoff = await lifecycle.resumeReloadInterruptedWorkflowRuns(piState.pi, ctxState.ctx);
	const notificationText = ctxState.notifications.map((n) => n.message).join("\n---\n");
	const wakeText = piState.userMessages.map((m) => m.message).join("\n---\n");

	check(
		"completed handoff: recorded as settled, not skipped",
		handoff.settled?.includes(runId) && !handoff.skipped?.includes(runId),
		JSON.stringify(handoff),
	);
	check(
		"completed handoff: fresh ctx gets completion notification",
		/Background workflow completed/.test(notificationText),
		notificationText,
	);
	check(
		"completed handoff: fresh ctx wake mentions the completed run",
		wakeText.includes(runId) && /State: completed/.test(wakeText),
		wakeText,
	);
	check(
		"completed handoff: no bogus manual resume guidance",
		!/resume <runId>|Use \/workflow resume/i.test(notificationText),
		notificationText,
	);
	check(
		"completed handoff: entry consumed",
		globalThis.__pandiDynamicWorkflowsReloadHandoff.size === 0,
		String(globalThis.__pandiDynamicWorkflowsReloadHandoff.size),
	);
}

async function scenarioQuitDoesNotAutoResume(url) {
	const project = await makeProject();
	const sharedExecCalls = [];
	const firstMod = await loadExtensionModule(url);
	const firstExt = firstMod.default;
	const firstPi = makePi("quit-before", sharedExecCalls);
	const firstCtx = makeCtx(project, "quit-before");
	firstExt(firstPi.pi);
	await emit(firstPi.handlers, "session_start", { reason: "startup" }, firstCtx.ctx);

	const startResponse = await runTool(firstPi.tools.get("dynamic_workflow"), firstCtx.ctx, {
		action: "start",
		name: "reload-probe",
		timeoutMs: 30_000,
	});
	const status = startResponse.details.status;
	await waitForBarrierStarted(status.runDir);
	await emit(firstPi.handlers, "session_shutdown", { reason: "quit" }, firstCtx.ctx);
	const cancelled = await readJsonIfExists(path.join(status.runDir, "result.json"));
	check("quit: non-reload shutdown still cancels", cancelled?.state === "cancelled", JSON.stringify(cancelled));

	const secondMod = await loadExtensionModule(url);
	const secondExt = secondMod.default;
	const secondPi = makePi("quit-after", sharedExecCalls);
	const secondCtx = makeCtx(project, "quit-after");
	secondExt(secondPi.pi);
	await emit(secondPi.handlers, "session_start", { reason: "reload" }, secondCtx.ctx);
	const stillCancelled = await readJsonIfExists(path.join(status.runDir, "result.json"));
	check(
		"quit: no reload handoff is queued for ordinary shutdown",
		stillCancelled?.state === "cancelled" && bashExecCalls(sharedExecCalls).length === 1,
		JSON.stringify({ stillCancelled, execCalls: sharedExecCalls }),
	);
	await emit(secondPi.handlers, "session_shutdown", { reason: "quit" }, secondCtx.ctx);
}

async function main() {
	const { url } = await buildExtension();
	const { url: lifecycleUrl } = await buildLifecycleModule();
	await scenarioReloadAutoResume(url);
	await scenarioMultipleReloadAutoResume(url);
	await scenarioReloadHandoffRequiresReloadStartAndMatchingCwd(url);
	await scenarioCompletedDuringReloadHandoffNotifiesFreshSession(lifecycleUrl);
	await scenarioQuitDoesNotAutoResume(url);
	console.log(`\nTOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
