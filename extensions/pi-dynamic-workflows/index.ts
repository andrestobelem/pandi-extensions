/**
 * Claude-style Dynamic Workflows for Pi.
 *
 * This extension adds:
 * - `dynamic_workflow` tool for the model to list/read/write/run workflow scripts
 * - `/workflow` and `/workflows` commands for humans
 * - `/dynamic-workflow` and `/deep-research` routing commands
 * - a small JavaScript workflow runtime with parallel Pi subagents and artifacts
 *
 * Workflows are trusted code. They run inside the Pi process (not a security
 * sandbox) and can spend model calls by spawning subagents.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	applyDefaultAgentAccess,
	applyPersonaOptions,
	createAgentEnvWrapper,
	formatAgentAccessMarkdown,
	normalizeAgentEnvAccess,
	sanitizeEnvForCache,
} from "./agent-env-persona.js";
import { parsePiJsonModeOutput, parsePiJsonModeOutputLenient } from "./agent-output.js";
import {
	AsyncMutex,
	abortReasonMessage,
	type CombinedSignal,
	combineSignal,
	createSemaphore,
	mapLimit,
	sleep,
	throwIfAborted,
} from "./concurrency-primitives.js";
import { HARD_MAX_AGENTS, HARD_MAX_CONCURRENCY } from "./config.js";
import { phaseEventFields } from "./event-parser.js";
import {
	type AgentFocusMetrics,
	aggregateRunFocusMetrics,
	formatFocusMetricsMarkdown,
	parseAgentFocusMetrics,
} from "./focus-metrics.js";
import { extractJsonCandidate } from "./json-extract.js";
import { notify } from "./notify.js";
import { formatWorkflowCompositionPromptSummary, formatWorkflowPatternKeyList } from "./pattern-scaffolds.js";
import { runStreamingAgentProcess } from "./process-spawn.js";
import {
	appendSystemPromptOption,
	formatSchemaRetryPrompt,
	makeStructuredOutputSystemPrompt,
	validateStructuredData,
} from "./structured-output.js";
import { WORKFLOW_WORKER_SOURCE } from "./worker-source.js";

export { runProcess, runStreamingAgentProcess } from "./process-spawn.js";

import { installWorkflowDashboardDownEditor } from "./dashboard-down-editor.js";
import { startPiSessionHeartbeat, stopPiSessionHeartbeat } from "./pi-session.js";
import { abortActiveWorkflowRuns } from "./run-lifecycle.js";

export { settleWithinTimeout } from "./run-lifecycle.js";

import { handleTool, handleWorkflowCommand, handleWorkflowsCommand } from "./command-handlers.js";
import { openWorkflowDashboard } from "./dashboard-orchestration.js";
import {
	clearUltracodeContractGateStatus,
	clearUltracodeStatus,
	dynamicWorkflowToolAvailable,
	ensureDynamicWorkflowToolActive,
	extractUltracodeTask,
	isGeneratedUltracodePrompt,
	makeAlwaysOnUltracodeSystemPrompt,
	makeUltracodePrompt,
	parseToggleCommandValue,
	sendWorkflowPrompt,
	setUltracodeContractGateStatus,
	setUltracodeStatus,
} from "./ultracode.js";

export { liveAgentHeaderStatus } from "./agent-view.js";

import { resolveArtifactPath, resolveCwdPath } from "./path-safety.js";
import type {
	ActiveWorkflowRun,
	AgentOptions,
	AgentPhaseInfo,
	AskResult,
	BashResult,
	PreparedWorkflowRun,
	RunLimits,
	SubagentResult,
	WorkflowFile,
	WorkflowLogEntry,
	WorkflowRunResult,
	WorkflowRunState,
	WorkflowRunStatus,
	WorkflowScopeInput,
} from "./types.js";

export type {
	ActiveWorkflowRun,
	AgentMonitorModel,
	AgentMonitorState,
	AgentOptions,
	AgentPhaseInfo,
	BashResult,
	JournalCache,
	JournalRecord,
	PreparedWorkflowRun,
	RunLimits,
	SubagentResult,
	WorkflowFile,
	WorkflowLocation,
	WorkflowLogEntry,
	WorkflowRunRecord,
	WorkflowRunResult,
	WorkflowRunState,
	WorkflowRunStatus,
	WorkflowScope,
	WorkflowScopeInput,
} from "./types.js";

import { appendJsonLine } from "./file-append.js";
import { createRunDirectory, ensureDir, resolveWorkflow, slugify } from "./workflow-resolve.js";

export { appendFileMutexCount, appendJsonLine } from "./file-append.js";

import {
	clearWorkflowWidget,
	formatRunSummary,
	refreshActiveWorkflowStatus,
	setWorkflowIdleStatus,
} from "./run-status-ui.js";

export {
	booleanValue,
	formatAgentPhase,
	getAgentElapsedMs,
	isAgentMonitorState,
	mergeAgentMonitor,
	numberValue,
	phaseEventFields,
	readRunEvents,
	recordValue,
	stringArrayValue,
	stringValue,
} from "./event-parser.js";
export { selectRunByKey } from "./run-view.js";
export { extractUltracodeTask } from "./ultracode.js";

import { MAX_TOOL_TEXT, safeJson, stringify, truncate } from "./format.js";
import {
	appendJournalRecord,
	computeCallKey,
	computeCodeHash,
	normalizeBashResultForJournal,
	normalizeSubagentResultForJournal,
} from "./journal.js";
import { writeJsonFile, writeRunStatus } from "./run-store.js";

export { estimatePeakParallelAgents } from "./run-state.js";

export const WORKFLOW_DIR = "workflows";
export const WORKFLOW_DRAFT_DIR = path.join(WORKFLOW_DIR, "drafts");
export const WORKFLOW_RUN_DIR = path.join(WORKFLOW_DIR, "runs");
export const WORKFLOW_GRAPH_DIR = path.join(WORKFLOW_DIR, "graphs");
export const PI_SESSION_HEARTBEAT_MS = 5_000;
// Grace period after SIGTERM before escalating to SIGKILL for spawned child processes.
export const PROCESS_KILL_GRACE_MS = 2_000;
export const MAX_AGENT_OUTPUT_IN_RESULT = 24_000;
// Label embedded in the editor's top border (the violet prompt line) while
// always-on Ultracode routing is active, so the router state is visible there too.
const ULTRACODE_BORDER_LABEL = "ultracode auto";
// Best-effort inter-extension hook used by extensions/effort/index.ts for `/effort ultracode`.
const ULTRACODE_MODE_EVENT = "pi-dynamic-workflows:ultracode-mode";
export const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Resumable / idempotent runs: host-side content-address cache journal.
export const JOURNAL_FILE = "journal.jsonl";
const JOURNAL_VERSION = 4;
export const MAX_JOURNALED_STREAM = 200_000;

const TOOL_ACTIONS = [
	"list",
	"scaffold",
	"read",
	"write",
	"run",
	"start",
	"resume",
	"cancel",
	"delete",
	"graph",
	"runs",
	"view",
] as const;
const WORKFLOW_SCOPE_INPUTS = ["auto", "project", "global"] as const;

type ToolAction = (typeof TOOL_ACTIONS)[number];

export interface DynamicWorkflowToolParams {
	action: ToolAction;
	name?: string;
	scope?: WorkflowScopeInput;
	code?: string;
	input?: unknown;
	background?: boolean;
	force?: boolean;
	concurrency?: number;
	maxAgents?: number;
	timeoutMs?: number;
	agentTimeoutMs?: number;
}

interface InternalAgentOptions extends AgentOptions {
	__workflowPhase?: AgentPhaseInfo;
	__workflowNamespace?: string;
}

interface AgentSpec extends AgentOptions {
	prompt: string;
}

export const activeRuns = new Map<string, ActiveWorkflowRun>();

interface BashOptions {
	cwd?: string;
	timeoutMs?: number;
	throwOnError?: boolean;
	cache?: boolean;
	__workflowNamespace?: string;
}

interface AskOptions {
	kind?: "input" | "confirm" | "select";
	choices?: string[];
	placeholder?: string;
	default?: string | boolean;
	timeoutMs?: number;
	cache?: boolean;
	__workflowNamespace?: string;
}

interface WorkflowRuntimeApi {
	cwd: string;
	runId: string;
	runDir: string;
	input: unknown;
	limits: Readonly<RunLimits>;
	log(message: string, details?: unknown): Promise<void>;
	agent(prompt: string, options?: AgentOptions): Promise<SubagentResult>;
	agents(
		items: (string | AgentSpec)[],
		options?: AgentOptions & { concurrency?: number; settle?: false },
	): Promise<SubagentResult[]>;
	agents(
		items: (string | AgentSpec)[],
		options: AgentOptions & { concurrency?: number; settle: true },
	): Promise<(SubagentResult | null)[]>;
	workflow(name: string, input?: unknown): Promise<unknown>;
	ask(question: string, options?: AskOptions): Promise<string | boolean>;
	bash(command: string, options?: BashOptions): Promise<BashResult>;
	readFile(filePath: string, encoding?: BufferEncoding): Promise<string>;
	writeFile(filePath: string, data: string | Uint8Array): Promise<{ path: string }>;
	appendFile(filePath: string, data: string | Uint8Array): Promise<{ path: string }>;
	listFiles(dir?: string, options?: { maxFiles?: number }): Promise<string[]>;
	writeArtifact(name: string, data: unknown): Promise<{ path: string }>;
	appendArtifact(name: string, data: string | Uint8Array): Promise<{ path: string }>;
	sleep(ms: number): Promise<void>;
	json(value: unknown, maxChars?: number): string;
	compact(value: unknown, maxChars?: number): string;
}

const workflowToolSchema = Type.Object({
	action: StringEnum(TOOL_ACTIONS, {
		description:
			"Workflow operation to perform: list/scaffold/read/write/run/start/resume/cancel/delete/graph/runs/view. scaffold with no name lists the pattern catalog; scaffold with name=<key> returns a pattern scaffold. resume re-runs an interrupted run (stale/failed/cancelled) in place, reusing cached completed subagent/bash calls so they are not re-executed.",
	}),
	name: Type.Optional(
		Type.String({
			description:
				"Workflow name/path relative to the workflow directory (.js is added when omitted), run id for view/cancel/resume (defaults to latest for resume), or pattern key for action=scaffold.",
		}),
	),
	scope: Type.Optional(
		StringEnum(WORKFLOW_SCOPE_INPUTS, {
			description: "Use project .pi/workflows, global ~/.pi/agent/workflows, or auto resolution.",
		}),
	),
	code: Type.Optional(Type.String({ description: "JavaScript workflow source for action=write." })),
	input: Type.Optional(
		Type.Any({
			description: "JSON-serializable input passed to action=run/start workflow(ctx, input).",
		}),
	),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Compatibility flag for action=run/resume. In persistent TUI/RPC sessions, workflows always start in background; print/json mode falls back to foreground because no background session stays alive.",
		}),
	),
	force: Type.Optional(
		Type.Boolean({
			description: "For action=resume, allow resuming an already completed run (re-runs only uncached calls).",
		}),
	),
	concurrency: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: HARD_MAX_CONCURRENCY,
			description: "Default subagent concurrency.",
		}),
	),
	maxAgents: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: HARD_MAX_AGENTS,
			description: "Maximum subagents a workflow may spawn.",
		}),
	),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, description: "Overall workflow timeout in milliseconds." })),
	agentTimeoutMs: Type.Optional(
		Type.Integer({
			minimum: 1_000,
			description: "Default timeout for each subagent in milliseconds.",
		}),
	),
});

export async function prepareWorkflowRun(
	ctx: ExtensionContext,
	workflowName: string,
	background = false,
): Promise<PreparedWorkflowRun> {
	const started = Date.now();
	const { runId, runDir } = await createRunDirectory(ctx, workflowName, started);
	await ensureDir(path.join(runDir, "agents"));
	return { started, runId, runDir, background };
}

function makeModelArg(ctx: ExtensionContext): string | undefined {
	if (!ctx.model) return undefined;
	return `${ctx.model.provider}/${ctx.model.id}`;
}

// Scan a JS object/array literal starting at/after `start`, returning the index just past
// its matching close (string/line+block-comment aware). -1 if it cannot be balanced. Used to
// lift `export const meta = { ... }` out of a workflow without a brittle brace regex.
function matchBalancedLiteral(src: string, start: number): number {
	let i = start;
	while (i < src.length && /\s/.test(src[i])) i++;
	const open = src[i];
	if (open !== "{" && open !== "[") return -1;
	let depth = 0;
	let inStr: string | null = null;
	for (; i < src.length; i++) {
		const c = src[i];
		if (inStr) {
			if (c === "\\") {
				i++;
				continue;
			}
			if (c === inStr) inStr = null;
			continue;
		}
		if (c === "'" || c === '"' || c === "`") {
			inStr = c;
			continue;
		}
		if (c === "/" && src[i + 1] === "/") {
			const nl = src.indexOf("\n", i);
			if (nl < 0) return -1;
			i = nl;
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			const end = src.indexOf("*/", i + 2);
			if (end < 0) return -1;
			i = end + 1;
			continue;
		}
		if (c === "{" || c === "[") depth++;
		else if (c === "}" || c === "]") {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return -1;
}

// Compile a workflow's authored source into CommonJS the Worker can run. The single authoring
// contract is a top-level script that uses the injected globals (agent, parallel, pipeline,
// workflow, phase, log, args), optionally declares `export const meta = { ... }`, and ends with
// `return <value>`. We lift `meta` out, then wrap the body in an async function so its top-level
// `await`/`return` are legal. (A legacy `export default function` form is still accepted while the
// codebase migrates; it is removed once all scaffolds/tests use the single interface.)
export function transformWorkflowCode(code: string): string {
	if (/^\s*import\s/m.test(code)) {
		throw new Error(
			"Static import statements are not supported in workflows. Use the injected globals (agent, parallel, pipeline, workflow, phase, log, args).",
		);
	}

	// 1) Lift `export const meta = <object literal>;` (a pure literal by convention) so it neither
	//    trips the export check below nor lands inside the wrapper function.
	let body = code;
	let metaLiteral: string | undefined;
	const metaDecl = /(^|\n)([ \t]*)export\s+const\s+meta\s*=\s*/.exec(body);
	if (metaDecl) {
		const litStart = metaDecl.index + metaDecl[0].length;
		const litEnd = matchBalancedLiteral(body, litStart);
		if (litEnd < 0)
			throw new Error("Could not parse `export const meta = { ... }`; keep meta a pure object literal.");
		metaLiteral = body.slice(litStart, litEnd).trim();
		let after = litEnd;
		while (after < body.length && /\s/.test(body[after])) after++;
		if (body[after] === ";") after++;
		body = body.slice(0, metaDecl.index) + (metaDecl[1] ?? "") + body.slice(after);
	}

	// 2) Pick the compilation form:
	//    - legacy `export default ...`  -> rewrite to `module.exports = ...` (transitional).
	//    - legacy direct `module.exports = ...` -> pass through (transitional).
	//    - new top-level script (neither) -> wrap so top-level `await`/`return` are legal.
	const usesExportDefault = /(^|\n)\s*export\s+default\s/.test(body);
	const assignsModuleExports = /(^|\n)\s*module\.exports\s*=/.test(body);
	let output: string;
	if (usesExportDefault) {
		output = body
			.replace(
				/(^|\n)(\s*)export\s+default\s+async\s+function(\s+[A-Za-z_$][\w$]*)?\s*\(/m,
				(_m, nl, ind, name = "") => `${nl}${ind}module.exports = async function${name}(`,
			)
			.replace(
				/(^|\n)(\s*)export\s+default\s+function(\s+[A-Za-z_$][\w$]*)?\s*\(/m,
				(_m, nl, ind, name = "") => `${nl}${ind}module.exports = function${name}(`,
			)
			.replace(/(^|\n)(\s*)export\s+default\s+async\s*\(/m, (_m, nl, ind) => `${nl}${ind}module.exports = async (`)
			.replace(/(^|\n)(\s*)export\s+default\s*\(/m, (_m, nl, ind) => `${nl}${ind}module.exports = (`)
			.replace(
				/(^|\n)(\s*)export\s+default\s+([^;\n]+);?/m,
				(_m, nl, ind, expr) => `${nl}${ind}module.exports = ${expr};`,
			);
		if (/^\s*export\s/m.test(output)) {
			throw new Error(
				"Unexpected `export` in workflow. Write a top-level script that ends with `return <value>` plus an optional `export const meta = { ... }` (no other exports).",
			);
		}
	} else if (assignsModuleExports) {
		if (/^\s*export\s/m.test(body)) {
			throw new Error(
				"Unexpected `export` in workflow. Use `module.exports = ...`, or a top-level script that ends with `return <value>` plus an optional `export const meta = { ... }`.",
			);
		}
		output = body;
	} else {
		if (/^\s*export\s/m.test(body)) {
			throw new Error(
				"Only `export const meta = { ... }` is allowed as an export. Write a top-level script that ends with `return <value>`.",
			);
		}
		output = `module.exports = async function workflowMain() {\n${body}\n};\n`;
	}

	if (metaLiteral !== undefined) {
		output += `\ntry { module.exports.meta = ${metaLiteral}; } catch (_e) {}\n`;
	}
	return output;
}

// Bridges a per-call AbortSignal from the worker dispatcher into the agent closure without
// touching WorkflowRuntimeApi. runSubagent captures it synchronously at entry so it survives the
// occAssignMutex/semaphore awaits; ALS context is per async chain, so concurrent agent() calls
// never cross-talk. Set only for method==="agent" calls; everything else sees undefined and falls
// back to the run signal.
const callSignal = new AsyncLocalStorage<AbortSignal>();

async function executeWorkflowCode(
	workflowFile: WorkflowFile,
	code: string,
	api: WorkflowRuntimeApi,
	input: unknown,
	limits: Readonly<RunLimits>,
	signal: AbortSignal,
): Promise<unknown> {
	throwIfAborted(signal);
	const allowedMethods = new Set<keyof WorkflowRuntimeApi>([
		"log",
		"agent",
		"agents",
		"workflow",
		"ask",
		"bash",
		"readFile",
		"writeFile",
		"appendFile",
		"listFiles",
		"writeArtifact",
		"appendArtifact",
		"sleep",
	]);
	const worker = new Worker(WORKFLOW_WORKER_SOURCE, {
		eval: true,
		workerData: {
			workflowName: workflowFile.name,
			filePath: workflowFile.path,
			code: transformWorkflowCode(code),
			input,
			cwd: api.cwd,
			runId: api.runId,
			runDir: api.runDir,
			limits,
		},
	});

	return await new Promise<unknown>((resolve, reject) => {
		let settled = false;
		// Per-call abort handles for in-flight agent() calls, keyed by worker message id. An
		// abort-call message (a race() loser) aborts exactly one; cleanup disposes the rest.
		const callControllers = new Map<number, CombinedSignal>();

		const cleanup = () => {
			signal.removeEventListener("abort", onAbort);
			worker.removeAllListeners();
			void worker.terminate();
			for (const c of callControllers.values()) c.dispose();
			callControllers.clear();
		};

		const settle = (fn: (value?: unknown) => void, value?: unknown) => {
			if (settled) return;
			settled = true;
			cleanup();
			fn(value);
		};

		const safePost = (message: unknown) => {
			if (settled) return;
			try {
				worker.postMessage(message);
			} catch {
				// Worker may have exited between an async host call and the response.
			}
		};

		const onAbort = () => settle(reject, new Error(abortReasonMessage(signal)));
		signal.addEventListener("abort", onAbort, { once: true });

		worker.on("message", (message: any) => {
			if (!message || typeof message !== "object") return;
			if (message.type === "result") {
				settle(resolve, message.result);
				return;
			}
			if (message.type === "error") {
				settle(reject, new Error(message.error || "Workflow failed."));
				return;
			}
			if (message.type === "abort-call") {
				callControllers.get(message.id)?.abort(new Error("Call cancelled (race lost)."));
				return;
			}
			if (message.type !== "call") return;

			void (async () => {
				if (settled || signal.aborted) {
					safePost({
						type: "response",
						id: message.id,
						ok: false,
						error: abortReasonMessage(signal),
					});
					return;
				}
				const method = message.method as keyof WorkflowRuntimeApi;
				if (!allowedMethods.has(method) || typeof api[method] !== "function") {
					safePost({
						type: "response",
						id: message.id,
						ok: false,
						error: `Unsupported workflow API method: ${String(method)}`,
					});
					return;
				}
				try {
					if (method === "agent" || method === "ask") {
						// Per-call signal: aborts on run abort OR an abort-call (race loser). timeoutMs 0
						// => parent-only. Registered synchronously before any await, so an abort-call
						// can never arrive before its controller exists. The store is read by runSubagent/runAsk.
						const combined = combineSignal(signal, 0);
						callControllers.set(message.id, combined);
						try {
							const result = await callSignal.run(combined.signal, () =>
								(api[method] as any)(...(message.args ?? [])),
							);
							safePost({ type: "response", id: message.id, ok: true, result });
						} finally {
							combined.dispose();
							callControllers.delete(message.id);
						}
					} else {
						const result = await (api[method] as any)(...(message.args ?? []));
						safePost({ type: "response", id: message.id, ok: true, result });
					}
				} catch (err) {
					safePost({
						type: "response",
						id: message.id,
						ok: false,
						error: err instanceof Error ? err.stack || err.message : String(err),
					});
				}
			})();
		});

		worker.on("error", (err) => settle(reject, err));
		worker.on("exit", (code) => {
			if (!settled && code !== 0) settle(reject, new Error(`Workflow worker exited with code ${code}.`));
		});
	});
}

export async function runWorkflow(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	workflowFile: WorkflowFile,
	input: unknown,
	limits: RunLimits,
	signal: AbortSignal | undefined,
	onProgress?: (logs: WorkflowLogEntry[], status?: WorkflowRunStatus) => void,
	prepared?: PreparedWorkflowRun,
): Promise<WorkflowRunResult> {
	const preparedRun = prepared ?? (await prepareWorkflowRun(ctx, workflowFile.name, false));
	const { started, runId, runDir } = preparedRun;
	const runLimits: Readonly<RunLimits> = Object.freeze({ ...limits });
	const agentsDir = path.join(runDir, "agents");
	await ensureDir(agentsDir);

	const runSignal = combineSignal(signal, runLimits.timeoutMs);
	const agentSemaphore = createSemaphore(runLimits.concurrency, runSignal.signal);
	const trackedSubagents = new Set<Promise<unknown>>();
	const logs: WorkflowLogEntry[] = [];
	// Resumed runs start agentCount past the agents/NNNN artifacts already on disk
	// so freshly re-run subagents never overwrite the cached ones.
	let agentCount = preparedRun.resume?.baseAgentCount ?? 0;
	let agentPhaseCount = 0;
	let parallelAgents = 0;
	let peakParallelAgents = preparedRun.resume?.previousPeakParallelAgents ?? 0;
	let state: WorkflowRunState = "running";

	// Content-address cache (for resumable/idempotent runs).
	let codeHash = preparedRun.resume?.codeHash ?? "";
	const resumedFrom = preparedRun.resume?.resumedFrom;
	const journal = preparedRun.resume?.journal;
	const occCounters = new Map<string, number>();
	// Serializes the occ-assignment prologue (persona/access resolution + key + nextOcc).
	// runExclusive chains its queue synchronously at call time, so wrapping the prologue
	// in it pins occ assignment to synchronous emission order — independent of how the
	// persona/access fs awaits interleave under ctx.agents/parallel/pipeline concurrency.
	// This is what makes occ (and therefore resume-cache lookups) deterministic.
	const occAssignMutex = new AsyncMutex();
	// Per-artifact-path append locks: concurrent agents appending to the same shared
	// artifact must not interleave/corrupt each other's bytes (see appendArtifact).
	const appendArtifactMutexes = new Map<string, AsyncMutex>();
	let cachedCalls = 0;
	// Focus observability (research §4): per-agent metrics folded from each freshly-run
	// subagent's JSON-mode stdout, aggregated into metrics.json/metrics.md at run end.
	// Cached/resumed calls (served from the journal) are not re-run, so they are excluded.
	const focusByAgent: AgentFocusMetrics[] = [];

	// Assign the occurrence index for a key synchronously, in emission order.
	// Same key (identical args) -> 0, 1, 2, ...; distinct args -> distinct key.
	function nextOcc(key: string): number {
		const occ = occCounters.get(key) ?? 0;
		occCounters.set(key, occ + 1);
		return occ;
	}

	function journalLookup(key: string, occ: number): SubagentResult | BashResult | AskResult | undefined {
		return journal?.get(key)?.[occ];
	}

	function trackSubagent<T>(promise: Promise<T>): Promise<T> {
		const tracked = promise.finally(() => trackedSubagents.delete(tracked));
		trackedSubagents.add(tracked);
		return tracked;
	}

	async function appendEvent(event: unknown): Promise<void> {
		await appendJsonLine(path.join(runDir, "events.jsonl"), event);
	}

	function makeStatus(statusState: WorkflowRunState = state, now = Date.now()): WorkflowRunStatus {
		return {
			workflow: workflowFile.name,
			scope: workflowFile.scope,
			file: workflowFile.path,
			runId,
			runDir,
			state: statusState,
			background: preparedRun.background,
			active: statusState === "running" && activeRuns.has(runId),
			startedAt: new Date(started).toISOString(),
			updatedAt: new Date(now).toISOString(),
			...(statusState !== "running" && statusState !== "stale" ? { endedAt: new Date(now).toISOString() } : {}),
			elapsedMs: now - started,
			agentCount,
			agentConcurrency: runLimits.concurrency,
			maxAgents: runLimits.maxAgents,
			parallelAgents,
			peakParallelAgents,
			logs,
			...(logs.length ? { lastLog: logs[logs.length - 1] } : {}),
			...(codeHash ? { codeHash } : {}),
			...(cachedCalls ? { cachedCalls } : {}),
			...(resumedFrom ? { resumedFrom } : {}),
		};
	}

	async function persistStatus(statusState: WorkflowRunState = state): Promise<WorkflowRunStatus> {
		const status = makeStatus(statusState);
		await writeRunStatus(status);
		return status;
	}

	async function publishStatus(statusState: WorkflowRunState = state): Promise<WorkflowRunStatus> {
		const status = await persistStatus(statusState);
		onProgress?.(logs, status);
		return status;
	}

	async function log(message: string, details?: unknown): Promise<void> {
		const entry: WorkflowLogEntry = {
			time: new Date().toISOString(),
			message,
			...(details === undefined ? {} : { details }),
		};
		logs.push(entry);
		await appendEvent({ type: "log", ...entry });
		await publishStatus();
	}

	async function writeArtifact(name: string, data: unknown): Promise<{ path: string }> {
		throwIfAborted(runSignal.signal);
		const file = resolveArtifactPath(runDir, name);
		await ensureDir(path.dirname(file));
		const body = typeof data === "string" || data instanceof Uint8Array ? data : `${safeJson(data)}\n`;
		await fs.writeFile(file, body);
		await appendEvent({ type: "artifact", path: file });
		return { path: file };
	}

	async function appendArtifact(name: string, data: string | Uint8Array): Promise<{ path: string }> {
		throwIfAborted(runSignal.signal);
		const file = resolveArtifactPath(runDir, name);
		await ensureDir(path.dirname(file));
		// Serialize per-path so concurrent agents appending to a shared artifact never
		// interleave a partial write and corrupt it.
		let mutex = appendArtifactMutexes.get(file);
		if (!mutex) {
			mutex = new AsyncMutex();
			appendArtifactMutexes.set(file, mutex);
		}
		await mutex.runExclusive(() => fs.appendFile(file, data));
		await appendEvent({ type: "artifact_append", path: file });
		return { path: file };
	}

	async function runSubagent(prompt: string, options: InternalAgentOptions = {}): Promise<SubagentResult> {
		throwIfAborted(runSignal.signal);
		// Captured synchronously at entry so it survives the occAssignMutex/semaphore awaits. For a
		// race() loser this is the per-call signal that an abort-call aborts; for everything else it is
		// the run signal (the dispatcher wraps every agent() call, so a normal call is unchanged).
		const effectiveSignal = callSignal.getStore() ?? runSignal.signal;
		// Resolve options and assign the cache occurrence index under occAssignMutex. The
		// mutex queue is chained synchronously at call time, so even though persona/access
		// resolution awaits the filesystem, occ is assigned strictly in synchronous emission
		// order. Content-address cache: same key (identical args) -> occ 0,1,2,...; the
		// journal is keyed by (key, occ), so this ordering is what keeps resume lookups
		// correct under ctx.agents/parallel/pipeline concurrency. agent() is cached by
		// default; opt out with { cache: false }.
		const prologue = await occAssignMutex.runExclusive(async () => {
			let resolved = (await applyPersonaOptions(ctx, options)) as InternalAgentOptions;
			resolved = await applyDefaultAgentAccess(ctx, resolved);
			if (resolved.schema !== undefined) {
				resolved = appendSystemPromptOption(resolved, makeStructuredOutputSystemPrompt(resolved.schema));
			}
			const computedKey = computeCallKey("agent", [prompt, sanitizeAgentOpts(resolved)]);
			return { effectiveOptions: resolved, key: computedKey, occ: nextOcc(computedKey) };
		});
		const effectiveOptions = prologue.effectiveOptions;
		const { key, occ } = prologue;
		const phase = effectiveOptions.__workflowPhase;
		const envAccess = normalizeAgentEnvAccess(effectiveOptions);
		const accessMarkdown = formatAgentAccessMarkdown(effectiveOptions, envAccess);
		const cacheEnabled = effectiveOptions.cache !== false;
		if (cacheEnabled) {
			const hit = journalLookup(key, occ) as SubagentResult | undefined;
			if (hit && "artifactPath" in hit) {
				cachedCalls++;
				const cachedPhase =
					phase ??
					(hit.phaseIndex && hit.phaseTotal
						? {
								id: hit.phaseId ?? 0,
								index: hit.phaseIndex,
								total: hit.phaseTotal,
								...(hit.phaseLabel ? { label: hit.phaseLabel } : {}),
							}
						: undefined);
				const cachedHit: SubagentResult = {
					...hit,
					...(hit.tools?.length || !effectiveOptions.tools?.length ? {} : { tools: effectiveOptions.tools }),
					...(hit.excludeTools?.length || !effectiveOptions.excludeTools?.length
						? {}
						: { excludeTools: effectiveOptions.excludeTools }),
					...(hit.skills?.length || !effectiveOptions.skills?.length ? {} : { skills: effectiveOptions.skills }),
					includeSkills: hit.includeSkills ?? effectiveOptions.includeSkills,
					...(hit.extensions?.length || !effectiveOptions.extensions?.length
						? {}
						: { extensions: effectiveOptions.extensions }),
					includeExtensions: hit.includeExtensions ?? effectiveOptions.includeExtensions,
					...(hit.keys?.length || !envAccess.keyNames.length ? {} : { keys: envAccess.keyNames }),
					...(hit.missingKeys?.length || !envAccess.missingKeys.length
						? {}
						: { missingKeys: envAccess.missingKeys }),
					isolatedEnv: hit.isolatedEnv ?? envAccess.isolatedEnv,
				};
				await appendEvent({
					type: "agent",
					...cachedHit,
					...phaseEventFields(cachedPhase),
					state: "cached",
					promptAvailable: !!cachedHit.artifactPath,
					stdout: undefined,
					stderr: undefined,
					prompt: undefined,
				});
				await log(`agent cached: ${cachedHit.name}`, {
					key: key.slice(0, 12),
					occ,
					artifactPath: cachedHit.artifactPath,
					tools: cachedHit.tools,
					skills: cachedHit.skills,
					extensions: cachedHit.extensions,
					keys: cachedHit.keys,
					missingKeys: cachedHit.missingKeys,
					isolatedEnv: cachedHit.isolatedEnv,
					...phaseEventFields(cachedPhase),
				});
				return cachedHit;
			}
		}
		if (agentCount >= runLimits.maxAgents) {
			// Leave a journal/event + log trace before throwing: under agents({settle:true})
			// the rejection is swallowed into a null branch result, so without this record
			// a maxAgents-exceeded drop would be invisible.
			const capMessage = `Workflow exceeded maxAgents=${runLimits.maxAgents}.`;
			await appendEvent({
				type: "agent",
				name: effectiveOptions.name ?? "agent",
				state: "skipped",
				error: capMessage,
				...phaseEventFields(phase),
			});
			await log(`agent skipped (maxAgents=${runLimits.maxAgents} reached): ${effectiveOptions.name ?? "agent"}`, {
				maxAgents: runLimits.maxAgents,
				agentCount,
				...phaseEventFields(phase),
			});
			throw new Error(capMessage);
		}
		const id = ++agentCount;
		const name = effectiveOptions.name ?? `agent-${id}`;
		const startedAt = Date.now();
		const startedAtIso = new Date(startedAt).toISOString();
		const artifactName = `agents/${String(id).padStart(4, "0")}-${slugify(name)}.md`;
		const phaseFields = phaseEventFields(phase);
		const phaseLine = phase?.total
			? `\n- phase: P${phase.id} ${phase.index}/${phase.total}${phase.label ? ` (${phase.label})` : ""}`
			: "";
		const preliminaryArtifact = await writeArtifact(
			artifactName,
			`# ${name}\n\n- state: running\n- startedAt: ${startedAtIso}${phaseLine}\n\n## Access\n\n${accessMarkdown}\n\n## Prompt\n\n${prompt}\n`,
		);
		const liveStdoutArtifactName = artifactName.endsWith(".md")
			? `${artifactName.slice(0, -3)}.stdout.log`
			: `${artifactName}.stdout.log`;
		const liveStderrArtifactName = artifactName.endsWith(".md")
			? `${artifactName.slice(0, -3)}.stderr.log`
			: `${artifactName}.stderr.log`;
		const liveStdoutArtifact = await writeArtifact(liveStdoutArtifactName, "");
		const liveStderrArtifact = await writeArtifact(liveStderrArtifactName, "");
		let liveWriteTail: Promise<unknown> = Promise.resolve();
		// Keep the first live-write failure so it is traceable instead of silently dropped;
		// surfaced via log() once the attempt settles (see after `await liveWriteTail`).
		let liveWriteError: unknown;
		const appendLive = (file: string, chunk: Buffer) => {
			liveWriteTail = liveWriteTail
				.then(() => fs.appendFile(file, chunk))
				.catch((err) => {
					if (liveWriteError === undefined) liveWriteError = err;
				});
		};
		await appendEvent({
			type: "agent",
			id,
			name,
			state: "running",
			startedAt: startedAtIso,
			artifactPath: preliminaryArtifact.path,
			promptAvailable: true,
			...phaseFields,
			...(effectiveOptions.tools?.length ? { tools: effectiveOptions.tools } : {}),
			...(effectiveOptions.excludeTools?.length ? { excludeTools: effectiveOptions.excludeTools } : {}),
			...(effectiveOptions.skills?.length ? { skills: effectiveOptions.skills } : {}),
			...(effectiveOptions.includeSkills !== undefined ? { includeSkills: effectiveOptions.includeSkills } : {}),
			...(effectiveOptions.extensions?.length ? { extensions: effectiveOptions.extensions } : {}),
			...(effectiveOptions.includeExtensions !== undefined
				? { includeExtensions: effectiveOptions.includeExtensions }
				: {}),
			...(envAccess.keyNames.length ? { keys: envAccess.keyNames } : {}),
			...(envAccess.missingKeys.length ? { missingKeys: envAccess.missingKeys } : {}),
			isolatedEnv: envAccess.isolatedEnv,
		});
		await log(`agent ${id} start: ${name}`, {
			artifactPath: preliminaryArtifact.path,
			liveStdoutPath: liveStdoutArtifact.path,
			liveStderrPath: liveStderrArtifact.path,
			tools: effectiveOptions.tools,
			skills: effectiveOptions.skills,
			includeSkills: effectiveOptions.includeSkills,
			extensions: effectiveOptions.extensions,
			includeExtensions: effectiveOptions.includeExtensions,
			keys: envAccess.keyNames,
			missingKeys: envAccess.missingKeys,
			isolatedEnv: envAccess.isolatedEnv,
			...phaseFields,
		});

		function buildAgentArgs(attemptPrompt: string): string[] {
			const args = ["-p", "--no-session", "--mode", "json"];
			const explicitExtensions = effectiveOptions.extensions ?? [];
			if (effectiveOptions.includeExtensions !== true) args.push("--no-extensions");
			for (const extensionPath of explicitExtensions) args.push("--extension", extensionPath);
			const explicitSkills = effectiveOptions.skills ?? [];
			if (
				effectiveOptions.includeSkills === false ||
				(explicitSkills.length > 0 && effectiveOptions.includeSkills !== true)
			)
				args.push("--no-skills");
			for (const skillPath of explicitSkills) args.push("--skill", skillPath);
			if (effectiveOptions.approve ?? ctx.isProjectTrusted()) args.push("--approve");
			else args.push("--no-approve");
			if (effectiveOptions.useContextFiles === false) args.push("--no-context-files");
			const model = effectiveOptions.model ?? (effectiveOptions.provider ? undefined : makeModelArg(ctx));
			// A BARE pattern alias ("sonnet"/"opus"/"haiku" — no "provider/") resolves through pi's provider
			// routing and can land on an UNauthenticated provider (e.g. amazon-bedrock -> "No API key found"),
			// which silently kills the subagent. Pin a bare alias to the session's provider so the shared
			// dual-platform scaffolds (which use bare aliases for Claude Code) resolve within the authenticated
			// provider on pi. An explicit provider always wins; qualified ids ("provider/id") and omitted models
			// (already qualified by makeModelArg) are left untouched.
			const provider =
				effectiveOptions.provider ?? (model && !model.includes("/") ? ctx.model?.provider : undefined);
			if (provider) args.push("--provider", provider);
			if (model) args.push("--model", model);
			const thinking = effectiveOptions.thinking ?? pi.getThinkingLevel?.();
			if (thinking) args.push("--thinking", String(thinking));
			if (effectiveOptions.tools?.length) args.push("--tools", effectiveOptions.tools.join(","));
			if (effectiveOptions.excludeTools?.length)
				args.push("--exclude-tools", effectiveOptions.excludeTools.join(","));
			if (effectiveOptions.systemPrompt) args.push("--system-prompt", effectiveOptions.systemPrompt);
			if (effectiveOptions.appendSystemPrompt)
				args.push("--append-system-prompt", effectiveOptions.appendSystemPrompt);
			args.push(attemptPrompt);
			return args;
		}

		const piCommand = process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND || "pi";
		let envWrapper: { path: string; dir: string } | undefined;
		function buildAgentProcess(attemptPrompt: string): { command: string; args: string[] } {
			const agentArgs = buildAgentArgs(attemptPrompt);
			if (!envWrapper) return { command: piCommand, args: agentArgs };
			return { command: envWrapper.path, args: [piCommand, ...agentArgs] };
		}
		const schema = effectiveOptions.schema;
		const schemaRetries = schema === undefined ? 0 : Math.max(0, Math.floor(effectiveOptions.schemaRetries ?? 2));
		const schemaOnInvalid = effectiveOptions.schemaOnInvalid ?? "throw";
		let result: { code: number; killed: boolean; stdout: string; stderr: string } | undefined;
		let output = "";
		let schemaData: unknown;
		let schemaOk: boolean | undefined;
		let schemaError = "";

		for (let attempt = 0; attempt <= schemaRetries; attempt++) {
			const attemptPrompt = attempt === 0 ? prompt : formatSchemaRetryPrompt(prompt, schemaError);
			if (attempt > 0)
				await log(`agent ${id} schema retry ${attempt}/${schemaRetries}: ${name}`, {
					error: schemaError,
				});
			const release = await agentSemaphore.acquire();
			parallelAgents++;
			peakParallelAgents = Math.max(peakParallelAgents, parallelAgents);
			let countedParallelSlot = true;
			let attemptWrapper: { path: string; dir: string } | undefined;
			try {
				// (B1) A loser aborted DURING setup (resume cache-hit winner, or concurrency<branches)
				// throws here BEFORE spawning -> no token spend. First statement inside the try so the
				// finally still releases the semaphore (acquire is outside the try).
				throwIfAborted(effectiveSignal);
				await publishStatus();
				attemptWrapper = envAccess.useEnvCommand ? await createAgentEnvWrapper(envAccess) : undefined;
				envWrapper = attemptWrapper;
				const processSpec = buildAgentProcess(attemptPrompt);
				result = await runStreamingAgentProcess(processSpec.command, processSpec.args, {
					cwd: effectiveOptions.cwd ?? ctx.cwd,
					timeoutMs: effectiveOptions.timeoutMs ?? runLimits.agentTimeoutMs,
					signal: effectiveSignal,
					// Recursion guard: stamp the child one level deeper so a nested dynamic_workflow
					// start/run/resume is refused once it hits maxWorkflowDepth().
					env: { ...process.env, [WORKFLOW_DEPTH_ENV]: String(currentWorkflowDepth() + 1) },
					onStdout: (chunk) => appendLive(liveStdoutArtifact.path, chunk),
					onStderr: (chunk) => appendLive(liveStderrArtifact.path, chunk),
				});
				await liveWriteTail;
				if (liveWriteError !== undefined) {
					await log(`agent ${id} live output write error: ${name}`, {
						error: liveWriteError instanceof Error ? liveWriteError.message : String(liveWriteError),
					});
				}
			} finally {
				envWrapper = undefined;
				if (attemptWrapper) await fs.rm(attemptWrapper.dir, { recursive: true, force: true }).catch(() => {});
				if (countedParallelSlot) {
					countedParallelSlot = false;
					parallelAgents = Math.max(0, parallelAgents - 1);
					await publishStatus().catch(() => {});
				}
				release();
			}
			throwIfAborted(effectiveSignal);
			const parsedStrictOutput = parsePiJsonModeOutput(result.stdout);
			const parsedOutput = parsedStrictOutput.ok ? parsedStrictOutput : parsePiJsonModeOutputLenient(result.stdout);
			if (!parsedStrictOutput.ok) {
				await log(`agent ${id} json output ${parsedOutput.ok ? "recovered" : "fallback"}: ${name}`, {
					warning: parsedStrictOutput.warning,
					...(parsedOutput.ok ? {} : { lenientWarning: parsedOutput.warning }),
					attempt: attempt + 1,
				});
			}
			// Full (untruncated) text. Schema extraction/validation must run on this so a
			// long-but-valid JSON payload is not silently cut by the display truncation
			// below, which would misattribute a length failure to a schema mismatch and
			// trigger a wasted, misleading retry. `output` (returned/displayed) stays bounded.
			const fullOutput = parsedOutput.ok ? parsedOutput.output : result.stdout.trim() || result.stderr.trim();
			output = truncate(fullOutput, MAX_AGENT_OUTPUT_IN_RESULT);
			if (schema === undefined) break;
			const extracted = extractJsonCandidate(fullOutput);
			if (!extracted.ok) {
				schemaOk = false;
				schemaError = extracted.error;
				continue;
			}
			const validation = validateStructuredData(schema, extracted.data);
			if (validation.ok) {
				schemaOk = true;
				schemaData = extracted.data;
				break;
			}
			schemaOk = false;
			schemaError = validation.errors.join("\n") || "schema validation failed";
		}

		if (!result) throw new Error(`Agent did not produce a result: ${name}`);
		if (schema !== undefined && schemaOk !== true && schemaOnInvalid === "null") schemaData = null;
		const schemaShouldThrow = schema !== undefined && schemaOk !== true && schemaOnInvalid !== "null";
		const endedAtIso = new Date().toISOString();
		const elapsedMs = Date.now() - startedAt;
		// Fold this agent's JSON-mode stdout into focus metrics (tokens, tool-error rate,
		// retries) for the per-run observability artifact. Pure + fail-safe; never throws.
		const focus = parseAgentFocusMetrics(result.stdout, {
			id,
			name,
			ok: result.code === 0 && !result.killed,
			elapsedMs,
		});
		focusByAgent.push(focus);
		const focusLine = `\n- focus: ${focus.turns} turns, peakInput ${focus.inputTokensPeak} tok, out ${focus.outputTokensTotal} tok, tools ${focus.toolCalls} (${focus.toolErrors} err), retries ${focus.autoRetries}`;
		const artifact = await writeArtifact(
			artifactName,
			`# ${name}\n\n- ok: ${result.code === 0 && !result.killed}\n- code: ${result.code}\n- elapsedMs: ${elapsedMs}${focusLine}${phaseLine}${schema === undefined ? "" : `\n- schemaOk: ${schemaOk === true}`}\n\n## Access\n\n${accessMarkdown}\n\n## Prompt\n\n${prompt}${schema === undefined ? "" : `\n\n## Structured Output\n\n${schemaOk === true ? `Data:\n\n${safeJson(schemaData)}` : `Error:\n\n${schemaError || "schema validation failed"}`}`}\n\n## Stdout\n\n${result.stdout}\n\n## Stderr\n\n${result.stderr}\n`,
		);
		const rawSubagent: SubagentResult = {
			id,
			name,
			ok: result.code === 0 && !result.killed,
			code: result.code,
			killed: result.killed,
			elapsedMs,
			prompt,
			output,
			stdout: result.stdout,
			stderr: result.stderr,
			artifactPath: artifact.path,
			...(effectiveOptions.tools?.length ? { tools: effectiveOptions.tools } : {}),
			...(effectiveOptions.excludeTools?.length ? { excludeTools: effectiveOptions.excludeTools } : {}),
			...(effectiveOptions.skills?.length ? { skills: effectiveOptions.skills } : {}),
			...(effectiveOptions.includeSkills !== undefined ? { includeSkills: effectiveOptions.includeSkills } : {}),
			...(effectiveOptions.extensions?.length ? { extensions: effectiveOptions.extensions } : {}),
			...(effectiveOptions.includeExtensions !== undefined
				? { includeExtensions: effectiveOptions.includeExtensions }
				: {}),
			...(envAccess.keyNames.length ? { keys: envAccess.keyNames } : {}),
			...(envAccess.missingKeys.length ? { missingKeys: envAccess.missingKeys } : {}),
			isolatedEnv: envAccess.isolatedEnv,
			...phaseFields,
			...(schema === undefined ? {} : { data: schemaData, schemaOk: schemaOk === true }),
		};
		const subagent = cacheEnabled ? normalizeSubagentResultForJournal(rawSubagent) : rawSubagent;
		// A loser whose abort ARRIVED produces a hole, never a record or a phantom "completed" event.
		// (A loser that completed before the abort round-tripped still journals -> B2, accepted.)
		if (effectiveSignal.aborted && !runSignal.signal.aborted)
			await log("agent cancelled (race lost)", { key: key.slice(0, 12), occ });
		throwIfAborted(effectiveSignal);
		await appendEvent({
			type: "agent",
			...subagent,
			state: subagent.ok ? "completed" : "failed",
			startedAt: startedAtIso,
			endedAt: endedAtIso,
			promptAvailable: true,
			stdout: undefined,
			stderr: undefined,
			prompt: undefined,
		});
		if (!schemaShouldThrow && cacheEnabled) {
			await appendJournalRecord(runDir, {
				v: JOURNAL_VERSION,
				key,
				occ,
				method: "agent",
				codeHash,
				ts: new Date().toISOString(),
				result: subagent,
			});
		}
		await log(`agent ${id} end: ${name}`, {
			ok: subagent.ok,
			code: subagent.code,
			elapsedMs,
			tools: subagent.tools,
			skills: subagent.skills,
			extensions: subagent.extensions,
			keys: subagent.keys,
			missingKeys: subagent.missingKeys,
			...phaseFields,
			...(schema === undefined ? {} : { schemaOk: subagent.schemaOk }),
		});
		if (schemaShouldThrow)
			throw new Error(
				`Agent ${name} did not produce valid structured output: ${schemaError || "schema validation failed"}`,
			);
		return subagent;
	}

	// Copy of agent options excluding fields that do not affect model output, so
	// the cache key is stable across name/timeout/cache changes. prompt is also
	// dropped: it is already the first element of the cache-key array, and
	// agents() spreads a spec (which carries prompt) into options, so excluding
	// it keeps the key dependent on the prompt exactly once.
	function sanitizeAgentOpts(options: AgentOptions): Record<string, unknown> {
		const {
			name: _name,
			timeoutMs: _timeoutMs,
			cache: _cache,
			concurrency: _concurrency,
			settle: _settle,
			agentType: _agentType,
			__workflowPhase: _workflowPhase,
			env,
			...rest
		} = options as InternalAgentOptions & {
			prompt?: string;
			concurrency?: number;
			settle?: boolean;
		};
		delete (rest as { prompt?: string }).prompt;
		return { ...rest, ...(env ? { env: sanitizeEnvForCache(env) } : {}) };
	}

	const agent = (prompt: string, options: InternalAgentOptions = {}) => trackSubagent(runSubagent(prompt, options));

	function makeRunAgents(
		agentRunner: (prompt: string, options?: InternalAgentOptions) => Promise<SubagentResult>,
	): WorkflowRuntimeApi["agents"] {
		async function runAgents(
			items: (string | AgentSpec)[],
			options: AgentOptions & { concurrency?: number; settle?: boolean } = {},
		): Promise<(SubagentResult | null)[]> {
			const concurrency = Math.min(
				Math.max(Math.floor(options.concurrency ?? runLimits.concurrency), 1),
				runLimits.concurrency,
			);
			const { concurrency: _concurrency, settle = false, ...sharedOptions } = options;
			const phaseId = items.length > 0 ? ++agentPhaseCount : 0;
			const phaseLabel =
				typeof sharedOptions.name === "string" && sharedOptions.name.trim()
					? sharedOptions.name.trim()
					: `agents-${phaseId}`;
			const runItem = async (item: string | AgentSpec, index: number): Promise<SubagentResult> => {
				const __workflowPhase: AgentPhaseInfo = {
					id: phaseId,
					index: index + 1,
					total: items.length,
					label: phaseLabel,
				};
				if (typeof item === "string")
					return await agentRunner(item, {
						...sharedOptions,
						__workflowPhase,
						name: sharedOptions.name ?? `agent-${index + 1}`,
					});
				const { prompt: itemPrompt, ...itemOptions } = item;
				return await agentRunner(itemPrompt, {
					...sharedOptions,
					...itemOptions,
					__workflowPhase,
					name: item.name ?? `agent-${index + 1}`,
				});
			};
			if (settle) return await mapLimit(items, concurrency, runSignal.signal, runItem, { onError: "null" });
			return await mapLimit(items, concurrency, runSignal.signal, runItem);
		}
		return runAgents as WorkflowRuntimeApi["agents"];
	}

	async function runBash(command: string, options: BashOptions = {}): Promise<BashResult> {
		throwIfAborted(runSignal.signal);
		// bash caching is opt-in: bash(cmd, { cache: true }). occ assigned
		// synchronously before any await for deterministic ordering.
		const cacheEnabled = options.cache === true;
		const key = computeCallKey("bash", [
			command,
			{
				cwd: options.cwd ?? ctx.cwd,
				...(options.__workflowNamespace ? { workflowNamespace: options.__workflowNamespace } : {}),
			},
		]);
		const occ = nextOcc(key);
		if (cacheEnabled) {
			const hit = journalLookup(key, occ);
			// "code" present + no artifactPath => BashResult (not a SubagentResult or AskResult). Keys never
			// collide across methods (computeCallKey namespaces by method), so this only narrows the type.
			if (hit && "code" in hit && !("artifactPath" in hit)) {
				cachedCalls++;
				await log(`bash cached: ${command.slice(0, 80)}`, {
					key: key.slice(0, 12),
					occ,
					...(options.__workflowNamespace ? { workflowNamespace: options.__workflowNamespace } : {}),
				});
				if (options.throwOnError && !hit.ok) {
					throw new Error(`Command failed (${hit.code}): ${command}\n${hit.stderr || hit.stdout}`);
				}
				return hit;
			}
		}
		const startedAt = Date.now();
		await log(
			`bash start: ${command.slice(0, 120)}`,
			options.__workflowNamespace ? { workflowNamespace: options.__workflowNamespace } : undefined,
		);
		const result = await pi.exec("bash", ["-lc", command], {
			cwd: options.cwd ?? ctx.cwd,
			timeout: options.timeoutMs ?? runLimits.agentTimeoutMs,
			signal: runSignal.signal,
		});
		throwIfAborted(runSignal.signal);
		const rawBashResult: BashResult = {
			ok: result.code === 0 && !result.killed,
			code: result.code,
			killed: result.killed,
			elapsedMs: Date.now() - startedAt,
			stdout: result.stdout,
			stderr: result.stderr,
		};
		const bashResult = cacheEnabled ? normalizeBashResultForJournal(rawBashResult) : rawBashResult;
		await appendEvent({
			type: "bash",
			command,
			...bashResult,
			...(options.__workflowNamespace ? { workflowNamespace: options.__workflowNamespace } : {}),
		});
		if (cacheEnabled) {
			await appendJournalRecord(runDir, {
				v: JOURNAL_VERSION,
				key,
				occ,
				method: "bash",
				codeHash,
				ts: new Date().toISOString(),
				result: bashResult,
			});
		}
		await log(`bash end: ${command.slice(0, 120)}`, {
			ok: bashResult.ok,
			code: bashResult.code,
			...(options.__workflowNamespace ? { workflowNamespace: options.__workflowNamespace } : {}),
		});
		if (options.throwOnError && !bashResult.ok) {
			throw new Error(`Command failed (${bashResult.code}): ${command}\n${bashResult.stderr || bashResult.stdout}`);
		}
		return bashResult;
	}

	// ask(question, options?) -> the human's answer via ctx.ui. Resume-safe: cached by default and
	// journaled by (key, occ) with method "ask", so a resumed run REPLAYS the recorded answer and never
	// re-prompts. Cancellation reuses the race() per-call signal bridge: the dispatcher wraps ask in the
	// callSignal ALS, so an abort-call (race loser) or run-abort dismisses the dialog via { signal } and
	// the post-abort guard throws WITHOUT journaling (leaving a hole, consistent with race semantics).
	async function runAsk(question: string, options: AskOptions = {}): Promise<string | boolean> {
		const effectiveSignal = callSignal.getStore() ?? runSignal.signal;
		throwIfAborted(effectiveSignal);
		// Eager validation (cheap synchronous guards inside ask()'s own surface) before any UI/journal:
		const hasChoices = options.choices !== undefined;
		if (options.kind === undefined && hasChoices && typeof options.default === "boolean") {
			throw new Error(
				"ask(): ambiguous kind — both choices and a boolean default were given; pass options.kind explicitly.",
			);
		}
		const kind: "input" | "confirm" | "select" =
			options.kind ?? (hasChoices ? "select" : typeof options.default === "boolean" ? "confirm" : "input");
		if (kind === "select" && (!Array.isArray(options.choices) || options.choices.length === 0)) {
			throw new Error("ask(): kind 'select' requires a non-empty options.choices array.");
		}
		const hasDefault = options.default !== undefined;
		if (kind === "select" && hasDefault && !(options.choices as string[]).includes(options.default as string)) {
			throw new Error("ask(): options.default for a select must be one of options.choices.");
		}
		const cacheEnabled = options.cache !== false;
		const namespace = options.__workflowNamespace;
		const key = computeCallKey("ask", [
			question,
			{
				kind,
				choices: kind === "select" ? (options.choices ?? []) : undefined,
				placeholder: options.placeholder,
				default: options.default,
				...(namespace ? { workflowNamespace: namespace } : {}),
			},
		]);
		const occ = nextOcc(key);
		if (cacheEnabled) {
			const hit = journalLookup(key, occ) as AskResult | undefined;
			if (hit && "answer" in hit) {
				cachedCalls++;
				await appendEvent({
					type: "ask",
					kind: hit.kind,
					question,
					answer: hit.answer,
					state: "cached",
					...(namespace ? { workflowNamespace: namespace } : {}),
				});
				await log(`ask cached: ${question.slice(0, 80)}`, { key: key.slice(0, 12), occ, answer: hit.answer });
				return hit.answer;
			}
		}
		const startedAt = Date.now();
		const dialogOpts = {
			signal: effectiveSignal,
			...(typeof options.timeoutMs === "number" ? { timeout: options.timeoutMs } : {}),
		};
		await log(`ask: ${question.slice(0, 120)}`, { kind, ...(namespace ? { workflowNamespace: namespace } : {}) });

		let answer: string | boolean;
		let dismissed = false;
		let defaulted = false;
		if (!ctx.hasUI) {
			if (!hasDefault) {
				throw new Error(
					`ask() needs a human but no UI is available (mode=${ctx.mode}); pass options.default to proceed headlessly.`,
				);
			}
			answer = options.default as string | boolean;
			defaulted = true;
		} else {
			let res: string | boolean | undefined;
			if (kind === "confirm") {
				res = await ctx.ui.confirm(
					question,
					typeof options.placeholder === "string" ? options.placeholder : "",
					dialogOpts,
				);
			} else if (kind === "select") {
				res = await ctx.ui.select(question, options.choices ?? [], dialogOpts);
			} else {
				res = await ctx.ui.input(question, options.placeholder, dialogOpts);
			}
			// Post-abort guard: a race loser / run abort dismisses the dialog -> throw WITHOUT journaling.
			throwIfAborted(effectiveSignal);
			if (res === undefined) {
				// confirm never returns undefined; input/select return undefined on dismiss/timeout.
				if (!hasDefault)
					throw new Error(`ask() was dismissed and no options.default was provided: ${question.slice(0, 80)}`);
				answer = options.default as string | boolean;
				dismissed = true;
				defaulted = true;
			} else {
				answer = res;
			}
		}
		throwIfAborted(effectiveSignal);
		const result: AskResult = {
			kind,
			answer,
			...(dismissed ? { dismissed: true } : {}),
			...(defaulted ? { defaulted: true } : {}),
			elapsedMs: Date.now() - startedAt,
		};
		await appendEvent({
			type: "ask",
			kind,
			question,
			answer,
			...(dismissed ? { dismissed: true } : {}),
			...(defaulted ? { defaulted: true } : {}),
			...(namespace ? { workflowNamespace: namespace } : {}),
		});
		if (cacheEnabled) {
			await appendJournalRecord(runDir, {
				v: JOURNAL_VERSION,
				key,
				occ,
				method: "ask",
				codeHash,
				ts: new Date().toISOString(),
				result,
			});
		}
		await log(`ask answered: ${question.slice(0, 80)}`, { answer, defaulted });
		return answer;
	}

	async function runSubworkflow(name: string, workflowInput: unknown = {}): Promise<unknown> {
		throwIfAborted(runSignal.signal);
		const subWorkflow = await resolveWorkflow(ctx, name, "auto");
		if (path.resolve(subWorkflow.path) === path.resolve(workflowFile.path)) {
			throw new Error(
				`workflow() refused recursive call to ${subWorkflow.name}. Sub-workflows are depth-1 and may not call their parent.`,
			);
		}
		const subCode = await fs.readFile(subWorkflow.path, "utf8");
		const subCodeHash = computeCodeHash(subCode);
		const workflowCallKey = computeCallKey("workflow", [subWorkflow.name, workflowInput]);
		const workflowOcc = nextOcc(workflowCallKey);
		const namespace = `workflow:${subWorkflow.name}:${subCodeHash.slice(0, 12)}:${workflowOcc}`;
		await appendEvent({
			type: "workflow",
			phase: "start",
			name: subWorkflow.name,
			file: subWorkflow.path,
			namespace,
			occ: workflowOcc,
		});
		await log(`sub-workflow start: ${subWorkflow.name}`, {
			file: subWorkflow.path,
			namespace,
			occ: workflowOcc,
			remainingAgents: Math.max(0, runLimits.maxAgents - agentCount),
		});
		try {
			const result = await executeWorkflowCode(
				subWorkflow,
				subCode,
				makeApi(namespace, false, workflowInput),
				workflowInput,
				runLimits,
				runSignal.signal,
			);
			await appendEvent({
				type: "workflow",
				phase: "end",
				name: subWorkflow.name,
				namespace,
				occ: workflowOcc,
				ok: true,
			});
			await log(`sub-workflow end: ${subWorkflow.name}`, {
				namespace,
				occ: workflowOcc,
				remainingAgents: Math.max(0, runLimits.maxAgents - agentCount),
			});
			return result;
		} catch (err) {
			const message = err instanceof Error ? err.stack || err.message : String(err);
			await appendEvent({
				type: "workflow",
				phase: "error",
				name: subWorkflow.name,
				namespace,
				occ: workflowOcc,
				ok: false,
				error: message,
			});
			await log(`sub-workflow failed: ${subWorkflow.name}`, {
				namespace,
				occ: workflowOcc,
				error: message,
			});
			throw err;
		}
	}

	function makeApi(
		workflowNamespace: string | undefined,
		allowWorkflow: boolean,
		apiInput: unknown,
	): WorkflowRuntimeApi {
		const namespacedAgent = (prompt: string, options: InternalAgentOptions = {}) =>
			agent(prompt, {
				...options,
				...(workflowNamespace ? { __workflowNamespace: workflowNamespace } : {}),
			});
		return {
			cwd: ctx.cwd,
			runId,
			runDir,
			input: apiInput,
			limits: runLimits,
			log,
			agent: namespacedAgent,
			agents: makeRunAgents(namespacedAgent),
			workflow: allowWorkflow
				? runSubworkflow
				: async () => {
						throw new Error(
							"workflow() composition depth limit is 1: sub-workflows cannot call other sub-workflows.",
						);
					},
			ask: async (question, options = {}) =>
				await runAsk(question, {
					...options,
					...(workflowNamespace ? { __workflowNamespace: workflowNamespace } : {}),
				}),
			bash: async (command, options = {}) =>
				await runBash(command, {
					...options,
					...(workflowNamespace ? { __workflowNamespace: workflowNamespace } : {}),
				}),
			readFile: async (filePath, encoding = "utf8") =>
				await fs.readFile(resolveCwdPath(ctx.cwd, filePath), encoding),
			writeFile: async (filePath, data) => {
				const file = resolveCwdPath(ctx.cwd, filePath);
				await ensureDir(path.dirname(file));
				await fs.writeFile(file, data);
				return { path: file };
			},
			appendFile: async (filePath, data) => {
				const file = resolveCwdPath(ctx.cwd, filePath);
				await ensureDir(path.dirname(file));
				await fs.appendFile(file, data);
				return { path: file };
			},
			listFiles: async (dir = ".", options = {}) => {
				const root = resolveCwdPath(ctx.cwd, dir);
				const maxFiles = options.maxFiles ?? 10_000;
				const files: string[] = [];
				async function walk(current: string): Promise<void> {
					if (files.length >= maxFiles) return;
					for (const entry of await fs.readdir(current, { withFileTypes: true })) {
						if (entry.name === "node_modules" || entry.name === ".git") continue;
						const full = path.join(current, entry.name);
						if (entry.isDirectory()) await walk(full);
						else if (entry.isFile()) files.push(path.relative(ctx.cwd, full).replaceAll(path.sep, "/"));
						if (files.length >= maxFiles) return;
					}
				}
				await walk(root);
				return files;
			},
			writeArtifact,
			appendArtifact,
			sleep: async (ms) => await sleep(ms, runSignal.signal),
			json: (value, maxChars = MAX_TOOL_TEXT) => stringify(value, maxChars),
			compact: (value, maxChars = MAX_TOOL_TEXT) => stringify(value, maxChars),
		};
	}

	const api = makeApi(undefined, true, input);

	let output: unknown;
	let error: string | undefined;
	try {
		await fs.writeFile(path.join(runDir, "input.json"), `${safeJson(input)}\n`, "utf8");
		// Read the code up front so codeHash is available before the first status
		// is written (resumes pass it in; fresh runs derive it here).
		const code = await fs.readFile(workflowFile.path, "utf8");
		if (!codeHash) codeHash = computeCodeHash(code);
		await persistStatus();
		await log(`workflow start: ${workflowFile.name}`, {
			file: workflowFile.path,
			runDir,
			...(resumedFrom ? { resumedFrom } : {}),
		});
		output = await executeWorkflowCode(workflowFile, code, api, input, runLimits, runSignal.signal);
		state = "completed";
		await log(`workflow end: ${workflowFile.name}`);
	} catch (err) {
		error = err instanceof Error ? err.stack || err.message : String(err);
		const reason = runSignal.signal.aborted ? abortReasonMessage(runSignal.signal) : "";
		state = reason.toLowerCase().includes("cancel") ? "cancelled" : "failed";
		await log(`workflow ${state}: ${workflowFile.name}`, { error });
	} finally {
		runSignal.abort();
		await Promise.allSettled([...trackedSubagents]);
		agentSemaphore.dispose();
		runSignal.dispose();
	}

	const ended = Date.now();
	const resultState: Exclude<WorkflowRunState, "running" | "stale"> =
		state === "completed" || state === "cancelled" ? state : "failed";
	const result: WorkflowRunResult = {
		workflow: workflowFile.name,
		scope: workflowFile.scope,
		file: workflowFile.path,
		runId,
		runDir,
		ok: resultState === "completed",
		state: resultState,
		background: preparedRun.background,
		startedAt: new Date(started).toISOString(),
		endedAt: new Date(ended).toISOString(),
		elapsedMs: ended - started,
		agentCount,
		agentConcurrency: runLimits.concurrency,
		maxAgents: runLimits.maxAgents,
		parallelAgents,
		peakParallelAgents,
		logs,
		...(output === undefined ? {} : { output }),
		...(error === undefined ? {} : { error }),
		...(codeHash ? { codeHash } : {}),
		...(cachedCalls ? { cachedCalls } : {}),
		...(resumedFrom ? { resumedFrom } : {}),
	};
	await writeJsonFile(path.join(runDir, "result.json"), result);
	await writeRunStatus({
		...makeStatus(resultState, ended),
		...(output === undefined ? {} : { output }),
		...(error === undefined ? {} : { error }),
	});
	await fs.writeFile(path.join(runDir, "summary.md"), formatRunSummary(result), "utf8");
	// Focus observability artifacts (research §4): aggregate per-agent metrics into a
	// machine-readable metrics.json + a human-readable metrics.md. Fully fail-safe so a
	// metrics write can never change the run's outcome.
	try {
		const focus = aggregateRunFocusMetrics(focusByAgent);
		// writeJsonFile/fs.writeFile are abort-agnostic, so these land even though the run
		// signal is already aborted by the finally above.
		await writeJsonFile(path.join(runDir, "metrics.json"), { ...focus, cachedCalls, agentCount });
		await fs.writeFile(path.join(runDir, "metrics.md"), formatFocusMetricsMarkdown(focus, { cachedCalls }), "utf8");
	} catch {
		/* metrics are best-effort observability; never fail the run on them */
	}
	return result;
}

// ---------------------------------------------------------------------------
// Recursion guard (PI_DYNAMIC_WORKFLOWS_DEPTH)
// ---------------------------------------------------------------------------
// ctx.workflow() composition is depth-1, and a single run is bounded by maxAgents, but a
// subagent spawned with includeExtensions:true + the dynamic_workflow tool could otherwise
// launch fresh top-level runs that are NOT counted against the parent's budget — unbounded
// nesting (a fork bomb). We propagate a per-session DEPTH env into every spawned subagent
// (depth+1) and refuse start/run/resume once a session is at the limit.
const WORKFLOW_DEPTH_ENV = "PI_DYNAMIC_WORKFLOWS_DEPTH";
const DEFAULT_MAX_WORKFLOW_DEPTH = 2;

/** Workflow-nesting depth of THIS session (0 at the top-level Pi session). */
export function currentWorkflowDepth(): number {
	const raw = Number.parseInt(process.env[WORKFLOW_DEPTH_ENV] ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** Max nesting before start/run/resume is refused (override via PI_DYNAMIC_WORKFLOWS_MAX_DEPTH). */
export function maxWorkflowDepth(): number {
	const raw = Number.parseInt(process.env.PI_DYNAMIC_WORKFLOWS_MAX_DEPTH ?? "", 10);
	return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MAX_WORKFLOW_DEPTH;
}

export default function dynamicWorkflowsExtension(pi: ExtensionAPI): void {
	let ultracodeAlwaysOn = true;
	let ultracodeContractGateEnabled = true;
	let currentCtx: ExtensionContext | undefined;

	pi.events?.on?.(ULTRACODE_MODE_EVENT, (data) => {
		const request = data as { enabled?: unknown } | undefined;
		ultracodeAlwaysOn = request?.enabled !== false;
		if (ultracodeAlwaysOn) ensureDynamicWorkflowToolActive(pi);
		if (currentCtx) setUltracodeStatus(currentCtx, ultracodeAlwaysOn);
	});

	pi.registerTool({
		name: "dynamic_workflow",
		label: "Dynamic Workflow",
		description:
			"Create, manage, and run Claude-style dynamic workflows: JavaScript orchestration scripts that can spawn parallel Pi subagents and store artifacts outside chat context.",
		promptSnippet: "Create/list/read/write/run/start JavaScript workflows that orchestrate parallel Pi subagents.",
		promptGuidelines: [
			"Step zero before orchestrating: decide whether the task prompt needs improvement. If ambiguity blocks routing or implementation, infer concise success criteria when safe or ask only blocking questions. Use that improved prompt for the routing/scouting decision.",
			"Decide in three steps before orchestrating. (1) Trivial gate: if the task is conversational, single-step, or solvable with a few direct tool calls, answer normally — do NOT build a workflow. (2) Scout inline first: if it may be large, run a cheap probe inline (git ls-files, read the diff, grep/glob candidates) to discover the real work-list and size. (3) Orchestrate only for exhaustiveness (many independent items), confidence (independent perspectives + adversarial verification), or scale (more context than one window: migrations, audits, broad sweeps).",
			"Scale effort to the ask. 'Find some' / 'quick check' -> small fan-out (~3-5) + light synthesis. 'Review this plan' -> a few perspective-diverse reviewers + synthesis-as-judge. 'Audit thoroughly' / 'be exhaustive' -> larger pool, adversarial checks per finding, synthesis, and another round only if new findings keep appearing.",
			"Scale parallelism to the discovered work-list and constraints. Raise concurrency/maxAgents above low defaults for many independent, read-only, low-risk branches when the limits global and provider budget/rate limits allow; keep them low for side effects, expensive models, shared-state edits, sequential dependencies, or uncertain rate limits. Log requested/effective concurrency, maxAgents, and any limits clamp.",
			"Author a workflow with injected GLOBALS only — no ctx, no import/require: an optional `export const meta = { name, description, phases }` plus `export default async function main()` (or a top-level script ending in `return <value>`). Read input via the `args` global (JSON-stringified; parse defensively). Globals: agent, agents, parallel, pipeline, workflow, phase, log, args, bash, readFile/writeFile/appendFile/listFiles, writeArtifact, sleep, json, compact, and the read-only limits/runId/runDir/cwd. NEVER name your function after a global (use main); naming it `workflow` shadows the workflow() composition helper and self-recurses.",
			formatWorkflowPatternKeyList(),
			formatWorkflowCompositionPromptSummary(),
			"Choose primitives by data dependency. Use agents(items,{concurrency}) for one independent step per item. Use pipeline(items,...stages) by default for >=2 dependent steps per item with no cross-item merge; include a stable item id/index in prompts generated inside stages. Use agents(items,{concurrency,settle:true}) for large fan-out or reviewer panels where one branch failure should return null. Use parallel([()=>...]) only for a true barrier where a later step needs all branch results at once (dedup/merge, early-exit if total=0, cross-branch ranking). Use workflow(name,args) for reusable sub-steps with no decision gate; sequence separate runs when a decision depends on prior output.",
			"Use agent(prompt,{schema}) when a subagent must return JSON: agent() returns the parsed object directly with {schema} (the text output otherwise) and null on a failed subagent. The plural agents()/parallel()/pipeline() return result objects/arrays (read .output/.data; null per failed branch under settle). Use agentType:'explore'|'reviewer'|'planner'|'implementer'|'researcher' for persona defaults; explicit options override the persona. Scope each subagent's access with tools/excludeTools, skills/includeSkills, extensions/includeExtensions, and keys/env when it needs specific capabilities; never put secret values in prompts. Subagents get web_search via pi-codex-web-search and context7-cli when installed; include web_search in read-only allowlists when web/docs/current evidence may help, and only use includeExtensions:false/includeSkills:false as an explicit opt-out.",
			"Decide model and reasoning per call: pass model ('haiku'|'sonnet'|'opus' or a full 'provider/id') and effort (low|medium|high|xhigh|max) on agent/agents/pipeline calls or any per-item spec (the node(role,extra) helper threads input.models/efforts/toolsByRole per role). Use a cheap/fast model + low effort for wide scouting, classification, and extraction; a stronger model + high/xhigh effort for synthesis, adversarial verification, planning, and hard reasoning. Omitting them inherits the orchestrator model and session reasoning level; agentType personas set defaults (reviewer/planner/researcher=high, explore/implementer=medium) and explicit options win. model and effort are part of the cache key, so changing them re-runs that call on resume.",
			"Handle partial failure visibly: filter nulls from settling agents/pipeline/parallel, log() how many branches failed, and make synthesis prompts mention failed, empty, cancelled, or timed-out branches instead of hiding them. In synthesis/judge prompts, restate the task + success criteria at BOTH the start and the end (after the evidence block), most-important findings first, to counter lost-in-the-middle.",
			"Never cap coverage silently. Whenever a workflow uses slice/head/top-N/sampling/no-retry, clamps concurrency to limits.concurrency, or lowers maxAgents below the discovered work-list, log() exactly what was excluded, delayed, or clamped.",
			"When creating a workflow, inspect the pattern catalog first (optionally action=scaffold name=<key> for a scaffold), reuse an existing workflow only when it exactly matches the task, otherwise write a clear gitignored .pi/workflows/drafts/<task-slug>.js project draft and launch it in background with explicit limits (action=start in persistent TUI/RPC; action=run only as the print/non-persistent fallback). If a workflow is warranted for complex workflow/prompt/contract design, use the workflow-factory scaffold so a workflow generates and reviews the task-specific workflow. After a useful run, tell the user the path and offer to keep/promote it to a stable workflow name.",
			"Workflows in persistent TUI/RPC sessions always run in background: use dynamic_workflow action=start (or action=run, which the extension backgrounds there), then inspect with action=runs/view and stop with action=cancel if needed.",
			"If a run was interrupted (state stale/failed/cancelled), use dynamic_workflow action=resume name=<runId> to continue it in place; completed subagent/bash calls are reused from the run journal and are not re-executed, so resuming is cheap. agent() output is cached by default (opt out with {cache:false}); bash() is cached only with {cache:true}. Calls whose arguments depend on Date.now()/Math.random() will not be cached and will re-run on resume.",
			"Build subagent prompts with a stable prefix: put shared/stable framing (role, task, success criteria, output format) FIRST and push volatile per-item content (the item text, ids, retrieved snippets) to the END, so identical prefixes reuse the provider prompt/KV cache across calls. Avoid Date.now()/Math.random() or other nondeterministic values inside prompts \u2014 they bust that cache and make the resume journal miss, re-running the call.",
			"Workflow scripts are trusted code. Keep subagent prompts scoped, use read-only tool lists for audit/research tasks, and persist intermediate outputs with writeArtifact().",
			"Use dynamic_workflow action=graph to explain a workflow before running it, and action=view/runs to inspect execution timelines and artifacts after running it.",
		],
		parameters: workflowToolSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return await handleTool(pi, params, signal, onUpdate, ctx);
		},
	});

	pi.registerCommand("workflow", {
		description:
			"Manage dynamic workflows: /workflow list|dashboard|agents|sessions|patterns|graph|runs|view|new|edit|run|start|resume|cancel|delete-run|delete",
		handler: async (args, ctx) => await handleWorkflowCommand(pi, args, ctx),
	});

	pi.registerCommand("workflows", {
		description: "Open the dynamic workflows dashboard (or pass through to /workflow, e.g. /workflows agents)",
		handler: async (args, ctx) => await handleWorkflowsCommand(pi, args, ctx),
	});

	pi.registerShortcut(Key.ctrlAlt("w"), {
		description: "Open dynamic workflows dashboard",
		handler: async (ctx) => await openWorkflowDashboard(pi, ctx),
	});

	pi.registerCommand("dynamic-workflow", {
		description: "Ask Pi to solve a complex task using dynamic workflows when warranted",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!task) {
				notify(ctx, "Usage: /dynamic-workflow <task>", "warning");
				return;
			}
			if (!ensureDynamicWorkflowToolActive(pi))
				notify(
					ctx,
					"dynamic_workflow tool is not active; dynamic-workflow will only provide routing guidance.",
					"warning",
				);
			sendWorkflowPrompt(pi, ctx, makeUltracodePrompt(task, "ultracode", ultracodeContractGateEnabled));
		},
	});

	// Alias of /dynamic-workflow so `/ultracode <task>` autocompletes in the command palette
	// (the bare word "ultracode" also triggers via the input transform below, but that never
	// registered a command). Keep the prompt byte-identical to /dynamic-workflow.
	pi.registerCommand("ultracode", {
		description: "Ask Pi to solve a complex task using dynamic workflows when warranted (alias of /dynamic-workflow)",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!task) {
				notify(ctx, "Usage: /ultracode <task>", "warning");
				return;
			}
			if (!ensureDynamicWorkflowToolActive(pi))
				notify(
					ctx,
					"dynamic_workflow tool is not active; ultracode will only provide routing guidance.",
					"warning",
				);
			sendWorkflowPrompt(pi, ctx, makeUltracodePrompt(task, "ultracode", ultracodeContractGateEnabled));
		},
	});

	pi.registerCommand("deep-research", {
		description: "Ask Pi to create/run a dynamic workflow for deep research",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!task) {
				notify(ctx, "Usage: /deep-research <research question>", "warning");
				return;
			}
			if (!ensureDynamicWorkflowToolActive(pi))
				notify(
					ctx,
					"dynamic_workflow tool is not active; deep-research will only provide routing guidance.",
					"warning",
				);
			sendWorkflowPrompt(pi, ctx, makeUltracodePrompt(task, "deep-research", ultracodeContractGateEnabled));
		},
	});

	pi.registerCommand("ultracode-contract", {
		description: "Show or toggle the Ultracode Contract Gate for this session",
		handler: async (args, ctx) => {
			const value = parseToggleCommandValue(args);
			if (value === "status") {
				setUltracodeContractGateStatus(ctx, ultracodeContractGateEnabled);
				notify(ctx, `Ultracode Contract Gate is ${ultracodeContractGateEnabled ? "enabled" : "disabled"}.`, "info");
				return;
			}
			if (value === "on") {
				ultracodeContractGateEnabled = true;
				setUltracodeContractGateStatus(ctx, ultracodeContractGateEnabled);
				notify(
					ctx,
					"Ultracode Contract Gate enabled: substantive workflow tasks will include task-contract review guidance.",
					"info",
				);
				return;
			}
			if (value === "off") {
				ultracodeContractGateEnabled = false;
				setUltracodeContractGateStatus(ctx, ultracodeContractGateEnabled);
				notify(
					ctx,
					"Ultracode Contract Gate disabled for this session; workflow routing remains available.",
					"warning",
				);
				return;
			}
			notify(ctx, "Usage: /ultracode-contract [on|off|status]", "warning");
		},
	});

	pi.registerCommand("ultracode-mode", {
		description: "Show or toggle always-on ultracode workflow routing for this session",
		handler: async (args, ctx) => {
			const value = parseToggleCommandValue(args);
			if (value === "status") {
				setUltracodeStatus(ctx, ultracodeAlwaysOn);
				notify(ctx, `Ultracode always-on is ${ultracodeAlwaysOn ? "enabled" : "disabled"}.`, "info");
				return;
			}
			if (value === "on") {
				ultracodeAlwaysOn = true;
				ensureDynamicWorkflowToolActive(pi);
				setUltracodeStatus(ctx, ultracodeAlwaysOn);
				notify(ctx, "Ultracode always-on enabled: Pi will evaluate each task for workflow routing.", "info");
				return;
			}
			if (value === "off") {
				ultracodeAlwaysOn = false;
				setUltracodeStatus(ctx, ultracodeAlwaysOn);
				notify(ctx, "Ultracode always-on disabled for this session.", "warning");
				return;
			}
			notify(ctx, "Usage: /ultracode-mode [on|off|status]", "warning");
		},
	});

	pi.on("input", (event) => {
		if (event.source === "extension") return;
		const task = extractUltracodeTask(event.text);
		if (!task) return;
		ensureDynamicWorkflowToolActive(pi);
		return {
			action: "transform" as const,
			text: makeUltracodePrompt(task, "ultracode", ultracodeContractGateEnabled),
			images: event.images,
		};
	});

	pi.on("before_agent_start", async (event) => {
		if (!ultracodeAlwaysOn) return;
		if (isGeneratedUltracodePrompt(event.prompt)) return;
		if (
			!dynamicWorkflowToolAvailable(event.systemPromptOptions.selectedTools) &&
			!ensureDynamicWorkflowToolActive(pi)
		)
			return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${makeAlwaysOnUltracodeSystemPrompt(ultracodeContractGateEnabled)}`,
		};
	});

	pi.on("session_start", async (event, ctx) => {
		currentCtx = ctx;
		await startPiSessionHeartbeat(event, ctx);
		installWorkflowDashboardDownEditor(pi, ctx, () => (ultracodeAlwaysOn ? ULTRACODE_BORDER_LABEL : undefined));
		if (ultracodeAlwaysOn) ensureDynamicWorkflowToolActive(pi);
		refreshActiveWorkflowStatus(ctx);
		setUltracodeStatus(ctx, ultracodeAlwaysOn);
		setUltracodeContractGateStatus(ctx, ultracodeContractGateEnabled);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await stopPiSessionHeartbeat();
		await abortActiveWorkflowRuns("Workflow cancelled by session shutdown.");
		clearWorkflowWidget(ctx);
		setWorkflowIdleStatus(ctx);
		clearUltracodeStatus(ctx);
		clearUltracodeContractGateStatus(ctx);
		currentCtx = undefined;
	});
}
