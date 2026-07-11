/**
 * Harness compartido para suites de integración de pandi-goal.
 *
 * Centraliza buildGoal / flush / makePi / makeCtx sin acoplar los escenarios entre sí.
 * Los mocks makePi/makeCtx siguen siendo configurables por suite vía opciones.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, bundle, loadDefault, makeBuildDir, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
export const EXT_DIR = path.join(REPO_ROOT, "extensions", "pandi-goal");

/** Replica constants.ts — fijado acá para que un cambio del límite aparezca en assertions. */
export const PROGRESS_LOG_KEEP = 12;
export const GOAL_STATE_TYPE = "goal-state";

const goalSdkStubs = { sdk: (dir) => sdkStub(dir) };

/** Bundle de un submódulo bajo extensions/pandi-goal/. */
export async function buildGoalModule({ name, relPath, outName, stubs = goalSdkStubs }) {
	return await buildExtension({
		name,
		src: path.join(EXT_DIR, relPath),
		outName,
		stubs,
	});
}

export async function buildVerifier({ name = "pi-goal-verifier-coverage" } = {}) {
	return await buildGoalModule({ name, relPath: "verifier.ts", outName: "verifier.mjs" });
}

export async function buildPersistence({ name = "pi-goal-persistence-integration" } = {}) {
	return await buildGoalModule({ name, relPath: "persistence.ts", outName: "persistence.mjs" });
}

export async function buildCommandIntent({ name = "pandi-goal-command-intent" } = {}) {
	const { outDir, aliases } = await makeBuildDir(name);
	const url = await bundle({
		src: path.join(EXT_DIR, "command-intent.ts"),
		outDir,
		outName: "command-intent.mjs",
		aliases,
	});
	return { outDir, url };
}

const DEFAULT_EXEC_RESULT = { code: 0, killed: false, stdout: "", stderr: "" };
const ZERO_DELAY_TIMER = Symbol("zero-delay-timer");

export async function buildGoal({ name = "pi-goal-integration" } = {}) {
	return await buildExtension({
		name,
		src: path.join(REPO_ROOT, "extensions", "pandi-goal", "index.ts"),
		outName: "goal.mjs",
		stubs: { typebox: true, sdk: (dir) => sdkStub(dir) },
	});
}

function normalizeFlushOptions(options, defaultTries = 50) {
	if (typeof options === "number") return { tries: options, mode: "immediate" };
	if (!options) return { tries: defaultTries, mode: "immediate" };
	return {
		tries: options.tries ?? defaultTries,
		mode: options.mode ?? "immediate",
	};
}

/**
 * Cede al event loop hasta que `predicate` sea true o se agoten los intentos.
 * - `immediate`: solo setImmediate (goal-verifier)
 * - `microtask`: Promise.resolve + setImmediate (goal-rehydrate)
 * - `timer`: setTimeout(0) + setImmediate (index-coverage)
 *
 * Acepta `flush(pred, 40)` (tries numérico) además de `flush(pred, { tries, mode })`.
 */
export async function flush(predicate, options) {
	const { tries, mode } = normalizeFlushOptions(options);
	for (let i = 0; i < tries; i++) {
		if (mode === "microtask") await Promise.resolve();
		if (mode === "timer") await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setImmediate(r));
		if (predicate?.()) return;
	}
}

export function makePi(
	execImpl,
	{ trackMessages = false, captureHandlers = true, defaultExec = DEFAULT_EXEC_RESULT } = {},
) {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const states = [];
	const execCalls = [];
	const messages = [];
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: (name, opts) => commands.set(name, opts),
		on: captureHandlers
			? (event, handler) => {
					if (!handlers.has(event)) handlers.set(event, []);
					handlers.get(event).push(handler);
				}
			: () => {},
		appendEntry: (customType, data) => {
			if (customType === "goal-state") states.push(data);
		},
		sendUserMessage:
			trackMessages === "envelope"
				? (prompt, opts) => messages.push({ prompt, opts })
				: trackMessages
					? (prompt) => messages.push(prompt)
					: () => {},
		exec: async (cmd, args, opts) => {
			execCalls.push({ cmd, args, opts });
			if (execImpl) return execImpl(cmd, args, opts);
			return defaultExec;
		},
	};
	return { pi, tools, commands, handlers, states, execCalls, messages };
}

export function makeCtx(overrides = {}) {
	return {
		mode: "tui",
		hasUI: true,
		cwd: REPO_ROOT,
		isIdle: () => true,
		isProjectTrusted: () => false,
		getContextUsage: () => undefined,
		ui: {
			theme: { fg: (_c, s) => s },
			notify: () => {},
			setStatus: () => {},
			confirm: async () => true,
			select: async () => undefined,
		},
		sessionManager: { getEntries: () => [] },
		...overrides,
	};
}

export function lastGoalStatus(states) {
	return states.length ? states[states.length - 1].gstatus : undefined;
}

export function lastGoalSnapshot(states) {
	return states.length ? states[states.length - 1] : undefined;
}

export function lastGoalSnapshotFor(states, goalId) {
	for (let i = states.length - 1; i >= 0; i--) if (states[i].goalId === goalId) return states[i];
	return undefined;
}

export function lastGoalStatusFor(states, goalId) {
	return lastGoalSnapshotFor(states, goalId)?.gstatus;
}

export async function loadFreshGoalExtension(goalUrl) {
	return await loadDefault(goalUrl);
}

export function goalStateEntry(snap) {
	return { type: "custom", customType: "goal-state", data: snap };
}

let _goalSnapId = 0;

/** ActiveGoal mínimo para verifier.ts (solo campos que lee el módulo). */
export function makeVerifierGoal(overrides = {}) {
	return {
		goalId: "g0001",
		objective: "ship the feature",
		successCriteria: undefined,
		derivedCriteria: undefined,
		assessments: [],
		verifierTimeoutMs: 120000,
		verifierTools: ["read", "grep", "find", "ls"],
		controller: new AbortController(),
		...overrides,
	};
}

/** ActiveGoal completo con campos runtime para persistence.ts. */
export function makeActiveGoal(overrides = {}) {
	return {
		goalId: "goal-sentinel-id",
		objective: "objective-sentinel",
		successCriteria: "success-sentinel",
		derivedCriteria: "derived-sentinel",
		ultracode: true,
		iteration: 7,
		maxIterations: 33,
		contextPercentCap: 71,
		assessments: [{ iteration: 1, status: "continue", assessment: "a0", at: "t0" }],
		verifyAttempts: 2,
		independentVerifyAttempts: 1,
		maxIndependentVerifications: 5,
		verifierTimeoutMs: 99000,
		verifierTools: ["read", "grep"],
		gstatus: "pursuing",
		startedAt: 1234567890,
		nextFireAt: 1234599999,
		lastReason: "reason-sentinel",
		updatedAt: "2020-01-01T00:00:00.000Z",
		timer: setTimeout(() => {}, 100000),
		controller: { abort() {} },
		rearmedThisTurn: true,
		verifierInFlight: true,
		...overrides,
	};
}

/** Ctx mínimo para verifier.ts (solo cwd). */
export function makeVerifierCtx(overrides = {}) {
	return { cwd: "/tmp/verifier-cwd", ...overrides };
}

/** Pi mínimo solo con exec (verifier-coverage). */
export function makeExecPi(result) {
	const execCalls = [];
	const pi = {
		exec: async (cmd, args, opts) => {
			execCalls.push({ cmd, args, opts });
			return typeof result === "function" ? result(cmd, args, opts) : result;
		},
	};
	return { pi, execCalls };
}

/** Pi mínimo solo con appendEntry (persistence-coverage). */
export function makeAppendPi() {
	const entries = [];
	return {
		pi: {
			appendEntry: (customType, data) => entries.push({ customType, data }),
		},
		entries,
	};
}

/** Goal base para tests de prompts/helpers. */
export function baseGoal(over = {}) {
	return {
		goalId: "g1",
		objective: "Make the build green",
		successCriteria: undefined,
		derivedCriteria: undefined,
		assessments: [],
		iteration: 1,
		maxIterations: 8,
		lastReason: undefined,
		ultracode: false,
		...over,
	};
}

export function makeGoalSnapshot(overrides = {}) {
	const goalId = overrides.goalId ?? `g${(_goalSnapId++).toString(16).padStart(4, "0")}`;
	return {
		goalId,
		objective: "ship the feature",
		successCriteria: "the tests pass",
		derivedCriteria: undefined,
		iteration: 1,
		maxIterations: 20,
		contextPercentCap: 80,
		assessments: [],
		verifyAttempts: 0,
		independentVerifyAttempts: 0,
		maxIndependentVerifications: 2,
		verifierTimeoutMs: 120000,
		verifierTools: ["read", "grep", "find", "ls"],
		gstatus: "pursuing",
		startedAt: new Date().toISOString(),
		nextFireAt: Date.now() + 1000,
		lastReason: "persisted snapshot",
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

export function installImmediateTimerHarness() {
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	globalThis.setTimeout = (handler, timeout = 0, ...args) => {
		const delay = Number(timeout) || 0;
		if (delay <= 0 && typeof handler === "function") {
			const handle = { [ZERO_DELAY_TIMER]: true, cleared: false };
			queueMicrotask(() => {
				if (!handle.cleared) handler(...args);
			});
			return handle;
		}
		return realSetTimeout(handler, timeout, ...args);
	};
	globalThis.clearTimeout = (handle) => {
		if (handle?.[ZERO_DELAY_TIMER]) {
			handle.cleared = true;
			return;
		}
		return realClearTimeout(handle);
	};
	return () => {
		globalThis.setTimeout = realSetTimeout;
		globalThis.clearTimeout = realClearTimeout;
	};
}

export async function registerGoalExtension(goalUrl, execImpl, makePiOpts = {}) {
	const goalExtension = await loadDefault(goalUrl);
	const built = makePi(execImpl, { trackMessages: "envelope", ...makePiOpts });
	goalExtension(built.pi);
	return built;
}

export async function fireSessionStart(built, event, ctx) {
	for (const handler of built.handlers.get("session_start") ?? []) await handler(event, ctx);
}

export async function fireAgentEnd(built, ctx) {
	for (const handler of built.handlers.get("agent_end") ?? []) await handler({}, ctx);
}

export async function fireSessionShutdown(built, ctx) {
	for (const handler of built.handlers.get("session_shutdown") ?? []) await handler({}, ctx);
}

export async function runGoalCommand(built, args, ctx) {
	const cmd = built.commands.get("goal");
	if (!cmd) throw new Error("goal command not registered");
	await cmd.handler(args, ctx);
}

export async function runGoalProgress(built, params, ctx) {
	const tool = built.tools.get("goal_progress");
	if (!tool) throw new Error("goal_progress tool not registered");
	return await tool.execute("tc", params, undefined, undefined, ctx);
}

export function makeGoalTestEnv(entries = [], opts = {}) {
	const { mode = "tui", reason = "startup", selectImpl } = opts;
	const notifies = [];
	const event = { reason };
	const ctx = makeCtx({
		mode,
		ui: {
			theme: { fg: (_c, s) => s },
			notify: (message, type) => notifies.push({ message, type }),
			setStatus: () => {},
			confirm: async () => true,
			select: async (q, items) => (selectImpl ? selectImpl(q, items) : undefined),
		},
		sessionManager: { getEntries: () => entries },
	});
	return { event, ctx, notifies };
}

export function makeRehydrateSession(entries, { reason = "startup", mode = "tui" } = {}) {
	return {
		event: { reason },
		ctx: makeCtx({
			mode,
			sessionManager: { getEntries: () => entries },
		}),
	};
}

export async function rehydrateGoalFrom(goalUrl, entries, { reason = "startup", execImpl, mode = "tui" } = {}) {
	const built = await registerGoalExtension(goalUrl, execImpl);
	const onStart = built.handlers.get("session_start");
	if (!onStart || onStart.length === 0) throw new Error("no session_start handler registered");
	const { event, ctx } = makeRehydrateSession(entries, { reason, mode });
	for (const handler of onStart) await handler(event, ctx);
	return { ctx, built };
}

/** Atajo para index-coverage: timer + setImmediate. */
export function flushWithTimer(predicate, tries = 100) {
	return flush(predicate, { mode: "timer", tries });
}

/** Atajo para goal-rehydrate: microtask + setImmediate. */
export function flushWithMicrotask(predicate, tries = 20) {
	return flush(predicate, { mode: "microtask", tries });
}

/** Atajo para persistence/fs: solo setImmediate con más intentos. */
export function flushFs(predicate, tries = 2000) {
	return flush(predicate, { mode: "immediate", tries });
}
