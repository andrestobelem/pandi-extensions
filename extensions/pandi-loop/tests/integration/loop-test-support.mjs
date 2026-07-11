/**
 * Harness compartido para suites de integración de pandi-loop.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

let TEST_PROJECT_ROOT = REPO_ROOT;
let TEST_CTX_SEQ = 0;

export function setTestProjectRoot(root) {
	TEST_PROJECT_ROOT = root;
}

export function getTestProjectRoot() {
	return TEST_PROJECT_ROOT;
}

export async function buildLoop({ name = "pi-loop-integration" } = {}) {
	return await buildExtension({
		name,
		src: path.join(REPO_ROOT, "extensions", "pandi-loop", "index.ts"),
		outName: "loop.mjs",
		stubs: { typebox: true, sdk: (dir) => sdkStub(dir) },
	});
}

export function makePi() {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const entries = [];
	const sentMessages = [];
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: (name, opts) => commands.set(name, opts),
		on: (event, handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
		sendUserMessage: (content, options) => sentMessages.push({ content, options }),
		exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
	};
	return { pi, tools, commands, handlers, entries, sentMessages };
}

export function makeCtx({ mode = "tui", hasUI = true, isIdle = true, trusted = true, usage, cwd, sessionId } = {}) {
	const notes = [];
	const ctxSeq = ++TEST_CTX_SEQ;
	const projectCwd = cwd ?? path.join(TEST_PROJECT_ROOT, `ctx-${ctxSeq}`);
	const effectiveSessionId = sessionId ?? `session-${ctxSeq}`;
	const ctx = {
		mode,
		hasUI,
		cwd: projectCwd,
		isIdle: () => (typeof isIdle === "function" ? isIdle() : isIdle),
		isProjectTrusted: () => (typeof trusted === "function" ? trusted() : trusted),
		getContextUsage: () => (typeof usage === "function" ? usage() : usage),
		ui: {
			theme: { fg: (_c, s) => s },
			notify: (msg, type) => notes.push({ msg, type }),
			setStatus: () => {},
			confirm: async () => true,
			select: async () => undefined,
		},
		sessionManager: { getEntries: () => [], getSessionId: () => effectiveSessionId },
	};
	ctx._notes = notes;
	return ctx;
}

export function latestSnapshot(entries, loopId) {
	let snap;
	for (const e of entries) {
		if (e.customType === "loop-state" && e.data && e.data.loopId === loopId) snap = e.data;
	}
	return snap;
}

export async function startLoopCmd(commands, entries, args, ctx) {
	const before = entries.length;
	await commands.get("loop").handler(args, ctx);
	for (let i = entries.length - 1; i >= before; i--) {
		const e = entries[i];
		if (e.customType === "loop-state" && e.data && e.data.loopId) return e.data.loopId;
	}
	return undefined;
}

export async function fireEvent(handlers, event, payload, ctx) {
	for (const h of handlers.get(event) || []) await h(payload, ctx);
}

export function snap(loopId, over = {}) {
	const now = Date.now();
	return {
		loopId,
		task: `task ${loopId}`,
		prompt: "p",
		mode: "dynamic",
		iteration: 0,
		maxIterations: 25,
		maxWallClockMs: 6 * 60 * 60 * 1000,
		contextPercentCap: 90,
		startedAt: now,
		nextFireAt: now + 60 * 60 * 1000,
		status: "stale",
		updatedAt: new Date(now).toISOString(),
		...over,
	};
}

export function seedEntries(ctx, snaps) {
	ctx.sessionManager.getEntries = () => snaps.map((data) => ({ type: "custom", customType: "loop-state", data }));
}

export function tick() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Ejecuta escenarios con build/teardown y reporte estándar. */
export async function runLoopScenarios({ name, scenarios, exitOnGreen = true }) {
	const { check, counts } = createChecker();
	const wrapped = scenarios.map((fn) => (url) => fn(url, check));
	const { outDir, url } = await buildLoop({ name });
	setTestProjectRoot(path.join(outDir, "project"));
	await fs.mkdir(getTestProjectRoot(), { recursive: true });
	try {
		for (const scenario of wrapped) await scenario(url);
	} finally {
		await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
	}

	console.log("");
	console.log(`TOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		console.log("FAILURES:");
		for (const f of counts.failures) console.log(`  - ${f}`);
		process.exit(1);
	}
	if (exitOnGreen) process.exit(0);
}

export { createChecker, loadDefault };
