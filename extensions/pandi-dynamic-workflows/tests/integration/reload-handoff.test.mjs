#!/usr/bin/env node
/**
 * Regression: background dynamic workflows survive `/reload` by interrupting the
 * old in-process attempt and auto-resuming the same runId in the fresh extension
 * instance. Completed cached calls must not be re-executed, and the stale
 * pre-reload ctx must not emit the expected reload-interrupt failure wake-up.
 *
 * Run it:
 *   node extensions/pandi-dynamic-workflows/tests/integration/reload-handoff.test.mjs
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const { check, counts } = createChecker();

const WORKFLOW = `
export const meta = { name: "reload-probe", description: "reload handoff probe" };
const first = await bash("printf first", { cache: true });
await log("after cached bash");
await sleep(1200);
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

async function waitForJournaledBash(runDir) {
	return await waitFor(
		"journaled bash",
		async () => {
			const body = await fs.readFile(path.join(runDir, "journal.jsonl"), "utf8").catch(() => "");
			return body.includes('"method":"bash"') || body.includes('"method": "bash"');
		},
		4000,
	);
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
	await waitForJournaledBash(status.runDir);
	check(
		"reload: first attempt executed cached bash once",
		sharedExecCalls.length === 1,
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
		sharedExecCalls.length === 1,
		JSON.stringify(sharedExecCalls),
	);
	check(
		"reload: final output comes from the cached first bash",
		completed.output?.first === "exec-1",
		JSON.stringify(completed.output),
	);
	check(
		"reload: fresh ctx receives the normal completion notification",
		secondCtx.notifications.some((n) => /completed/i.test(n.message)) && secondPi.userMessages.length === 1,
		JSON.stringify({ notifications: secondCtx.notifications, userMessages: secondPi.userMessages }),
	);

	await emit(secondPi.handlers, "session_shutdown", { reason: "quit" }, secondCtx.ctx);
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
	await waitForJournaledBash(status.runDir);
	await emit(firstPi.handlers, "session_shutdown", { reason: "quit" }, firstCtx.ctx);
	const cancelled = await readJsonIfExists(path.join(status.runDir, "result.json"));
	check("quit: non-reload shutdown still cancels", cancelled?.state === "cancelled", JSON.stringify(cancelled));

	const secondMod = await loadExtensionModule(url);
	const secondExt = secondMod.default;
	const secondPi = makePi("quit-after", sharedExecCalls);
	const secondCtx = makeCtx(project, "quit-after");
	secondExt(secondPi.pi);
	await emit(secondPi.handlers, "session_start", { reason: "reload" }, secondCtx.ctx);
	await new Promise((resolve) => setTimeout(resolve, 300));
	const stillCancelled = await readJsonIfExists(path.join(status.runDir, "result.json"));
	check(
		"quit: no reload handoff is queued for ordinary shutdown",
		stillCancelled?.state === "cancelled" && sharedExecCalls.length === 1,
		JSON.stringify({ stillCancelled, execCalls: sharedExecCalls }),
	);
	await emit(secondPi.handlers, "session_shutdown", { reason: "quit" }, secondCtx.ctx);
}

async function main() {
	const { url } = await buildExtension();
	await scenarioReloadAutoResume(url);
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
