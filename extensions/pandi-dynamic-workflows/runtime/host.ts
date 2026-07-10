import * as fs from "node:fs/promises";
import * as path from "node:path";

import { AsyncMutex, throwIfAborted } from "../lib/concurrency.js";
import { appendJsonLine } from "../lib/file-append.js";
import { safeJson } from "../lib/format.js";
import { resolveArtifactPath } from "../lib/path-safety.js";
import { hasActiveRun } from "../lifecycle/index.js";
import { ensureDir } from "../surface/index.js";
import type {
	PreparedWorkflowRun,
	RunLimits,
	SubagentResult,
	WorkflowDefinition,
	WorkflowLogEntry,
	WorkflowResultIntegrity,
	WorkflowRunState,
	WorkflowRunStatus,
} from "../types.js";
import { writeRunStatus } from "./store.js";

export type WorkflowRunHostDeps = {
	runDir: string;
	runId: string;
	workflowDefinition: WorkflowDefinition;
	preparedRun: PreparedWorkflowRun;
	started: number;
	runLimits: Readonly<RunLimits>;
	resumedFrom?: string;
	onProgress?: (logs: WorkflowLogEntry[], status?: WorkflowRunStatus) => void;
	signal: AbortSignal;
	getState: () => WorkflowRunState;
	getAgentCount: () => number;
	getParallelAgents: () => number;
	getPeakParallelAgents: () => number;
	getLogs: () => WorkflowLogEntry[];
	getCodeHash: () => string;
	getCachedCalls: () => number;
	getIntegrity: () => WorkflowResultIntegrity;
	bumpExplicitPhaseCount: () => number;
	trackedSubagents: Set<Promise<unknown>>;
};

export type WorkflowRunHost = {
	recordAgentIntegrity: (result: SubagentResult) => void;
	resultIntegrity: () => WorkflowResultIntegrity | undefined;
	trackSubagent: <T>(promise: Promise<T>) => Promise<T>;
	appendEvent: (event: unknown) => Promise<void>;
	makeStatus: (statusState?: WorkflowRunState, now?: number) => WorkflowRunStatus;
	persistStatus: (statusState?: WorkflowRunState) => Promise<WorkflowRunStatus>;
	publishStatus: (statusState?: WorkflowRunState) => Promise<WorkflowRunStatus>;
	log: (message: string, details?: unknown) => Promise<void>;
	phase: (label: string) => Promise<void>;
	writeArtifact: (name: string, data: unknown) => Promise<{ path: string }>;
	appendArtifact: (name: string, data: string | Uint8Array) => Promise<{ path: string }>;
};

export function createWorkflowRunHost(deps: WorkflowRunHostDeps): WorkflowRunHost {
	// Per-artifact-path append locks: concurrent agents appending to the same shared
	// artifact must not interleave/corrupt each other's bytes (see appendArtifact).
	const appendArtifactMutexes = new Map<string, AsyncMutex>();

	function recordAgentIntegrity(result: SubagentResult): void {
		const integrity = deps.getIntegrity();
		integrity.agentResults++;
		if (!result.ok) integrity.failedAgents++;
		if (result.outputEmpty) integrity.emptyOutputAgents++;
		if (result.outputTruncated) integrity.outputTruncatedAgents++;
		if (result.stdoutTruncated) integrity.stdoutTruncatedAgents++;
		if (result.timedOut) integrity.timedOutAgents++;
		if (result.schemaOk === false) integrity.schemaFailedAgents++;
	}

	function resultIntegrity(): WorkflowResultIntegrity | undefined {
		const integrity = deps.getIntegrity();
		if (integrity.agentResults === 0) return undefined;
		return {
			...integrity,
			agentOutputs: {
				observed: integrity.agentResults,
				ok: integrity.agentResults - integrity.failedAgents,
				failed: integrity.failedAgents,
				empty: integrity.emptyOutputAgents,
				truncated: integrity.outputTruncatedAgents,
				stdoutTruncated: integrity.stdoutTruncatedAgents,
				timedOut: integrity.timedOutAgents,
				schemaFailed: integrity.schemaFailedAgents,
			},
		};
	}

	function trackSubagent<T>(promise: Promise<T>): Promise<T> {
		const tracked = promise.finally(() => deps.trackedSubagents.delete(tracked));
		deps.trackedSubagents.add(tracked);
		return tracked;
	}

	async function appendEvent(event: unknown): Promise<void> {
		await appendJsonLine(path.join(deps.runDir, "events.jsonl"), event);
	}

	function makeStatus(statusState: WorkflowRunState = deps.getState(), now = Date.now()): WorkflowRunStatus {
		const logs = deps.getLogs();
		const integrity = resultIntegrity();
		return {
			workflow: deps.workflowDefinition.name,
			scope: deps.workflowDefinition.scope,
			file: deps.workflowDefinition.path,
			runId: deps.runId,
			runDir: deps.runDir,
			state: statusState,
			background: deps.preparedRun.background,
			active: statusState === "running" && hasActiveRun(deps.runId),
			startedAt: new Date(deps.started).toISOString(),
			updatedAt: new Date(now).toISOString(),
			...(statusState !== "running" && statusState !== "stale" ? { endedAt: new Date(now).toISOString() } : {}),
			elapsedMs: now - deps.started,
			agentCount: deps.getAgentCount(),
			agentConcurrency: deps.runLimits.concurrency,
			maxAgents: deps.runLimits.maxAgents,
			parallelAgents: deps.getParallelAgents(),
			peakParallelAgents: deps.getPeakParallelAgents(),
			logs,
			...(logs.length ? { lastLog: logs[logs.length - 1] } : {}),
			...(integrity ? { integrity } : {}),
			...(deps.getCodeHash() ? { codeHash: deps.getCodeHash() } : {}),
			...(deps.getCachedCalls() ? { cachedCalls: deps.getCachedCalls() } : {}),
			...(deps.resumedFrom ? { resumedFrom: deps.resumedFrom } : {}),
		};
	}

	async function persistStatus(statusState: WorkflowRunState = deps.getState()): Promise<WorkflowRunStatus> {
		const status = makeStatus(statusState);
		await writeRunStatus(status);
		return status;
	}

	async function publishStatus(statusState: WorkflowRunState = deps.getState()): Promise<WorkflowRunStatus> {
		const status = await persistStatus(statusState);
		deps.onProgress?.(deps.getLogs(), status);
		return status;
	}

	async function log(message: string, details?: unknown): Promise<void> {
		const entry: WorkflowLogEntry = {
			time: new Date().toISOString(),
			message,
			...(details === undefined ? {} : { details }),
		};
		deps.getLogs().push(entry);
		await appendEvent({ type: "log", ...entry });
		await publishStatus();
	}

	async function phase(label: string): Promise<void> {
		const text = String(label ?? "").trim();
		if (!text) return;
		const time = new Date().toISOString();
		const id = deps.bumpExplicitPhaseCount();
		await appendEvent({ type: "phase", id, label: text, time });
		await log(`phase: ${text}`);
	}

	async function writeArtifact(name: string, data: unknown): Promise<{ path: string }> {
		throwIfAborted(deps.signal);
		const file = resolveArtifactPath(deps.runDir, name);
		await ensureDir(path.dirname(file));
		const body = typeof data === "string" || data instanceof Uint8Array ? data : `${safeJson(data)}\n`;
		await fs.writeFile(file, body);
		await appendEvent({ type: "artifact", path: file });
		return { path: file };
	}

	async function appendArtifact(name: string, data: string | Uint8Array): Promise<{ path: string }> {
		throwIfAborted(deps.signal);
		const file = resolveArtifactPath(deps.runDir, name);
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

	return {
		recordAgentIntegrity,
		resultIntegrity,
		trackSubagent,
		appendEvent,
		makeStatus,
		persistStatus,
		publishStatus,
		log,
		phase,
		writeArtifact,
		appendArtifact,
	};
}
