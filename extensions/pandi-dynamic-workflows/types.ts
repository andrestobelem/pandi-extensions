/**
 * Shared contract types for pi-dynamic-workflows — the data shapes that flow between the engine
 * (index.ts) and its sibling modules: workflow files/locations/limits, agent options + results,
 * bash results, log entries, the run result/status/record union, journal records, prepared/active
 * runs, and the agent-monitor model. A pure type-only leaf (no imports, no runtime), so any module
 * can depend on the contract without importing the engine. index.ts re-exports these for back-compat.
 *
 * Extracted byte-identically from index.ts.
 */
export type WorkflowScope = "project" | "global";
export type WorkflowScopeInput = WorkflowScope | "auto";

export interface WorkflowFile {
	name: string;
	scope: WorkflowScope;
	path: string;
	relativePath: string;
}

export interface WorkflowLocation {
	scope: WorkflowScope;
	root: string;
	trusted: boolean;
	kind: "workflow" | "draft";
}

export interface RunLimits {
	concurrency: number;
	maxAgents: number;
	timeoutMs: number;
	agentTimeoutMs: number;
	syncTimeoutMs: number;
}

export interface AgentPhaseInfo {
	id: number;
	index: number;
	total: number;
	label?: string;
}

export interface AgentOptions {
	name?: string;
	cwd?: string;
	tools?: string[];
	excludeTools?: string[];
	skills?: string[];
	includeSkills?: boolean;
	extensions?: string[];
	keys?: string[];
	env?: Record<string, string>;
	inheritEnv?: boolean;
	model?: string;
	provider?: string;
	thinking?: string;
	timeoutMs?: number;
	includeExtensions?: boolean;
	approve?: boolean;
	useContextFiles?: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	cache?: boolean;
	agentType?: string;
	schema?: unknown;
	schemaRetries?: number;
	schemaOnInvalid?: "throw" | "null";
}

export interface SubagentResult {
	id: number;
	name: string;
	ok: boolean;
	code: number;
	killed: boolean;
	/** True when the agent's timeoutMs budget killed it (not an abort/race loss). */
	timedOut?: boolean;
	elapsedMs: number;
	/** Semaphore queue wait before the first spawn; elapsedMs includes it. */
	queuedMs?: number;
	prompt: string;
	output: string;
	stdout: string;
	stderr: string;
	artifactPath: string;
	/** Resolved model actually passed to the subagent (qualified provider/id when known). */
	model?: string;
	/** Resolved thinking/effort level actually passed to the subagent. */
	thinking?: string;
	tools?: string[];
	excludeTools?: string[];
	skills?: string[];
	includeSkills?: boolean;
	extensions?: string[];
	includeExtensions?: boolean;
	keys?: string[];
	missingKeys?: string[];
	isolatedEnv?: boolean;
	phaseId?: number;
	phaseIndex?: number;
	phaseTotal?: number;
	phaseLabel?: string;
	data?: unknown;
	schemaOk?: boolean;
}

export interface BashResult {
	ok: boolean;
	code: number;
	killed: boolean;
	elapsedMs: number;
	stdout: string;
	stderr: string;
}

// Result of an ask() human-in-the-loop call. Journaled by (key, occ) like agent/bash so a resumed
// run replays the recorded answer instead of re-prompting the human.
export interface AskResult {
	kind: "input" | "confirm" | "select";
	answer: string | boolean;
	dismissed?: boolean;
	defaulted?: boolean;
	elapsedMs: number;
}

export interface WorkflowLogEntry {
	time: string;
	message: string;
	details?: unknown;
}

export type WorkflowRunState = "running" | "completed" | "failed" | "cancelled" | "stale";

export interface WorkflowRunResult {
	workflow: string;
	scope: WorkflowScope;
	file: string;
	runId: string;
	runDir: string;
	ok: boolean;
	state?: Exclude<WorkflowRunState, "running" | "stale">;
	background?: boolean;
	startedAt: string;
	endedAt: string;
	elapsedMs: number;
	agentCount: number;
	agentConcurrency?: number;
	maxAgents?: number;
	parallelAgents?: number;
	peakParallelAgents?: number;
	logs: WorkflowLogEntry[];
	output?: unknown;
	error?: string;
	codeHash?: string;
	cachedCalls?: number;
	resumedFrom?: string;
}

export interface JournalRecord {
	v: number;
	key: string;
	occ: number;
	method: "agent" | "bash" | "ask";
	codeHash: string;
	ts: string;
	result: SubagentResult | BashResult | AskResult;
}

export type JournalCache = Map<string, (SubagentResult | BashResult | AskResult)[]>;

export interface PreparedWorkflowRun {
	started: number;
	runId: string;
	runDir: string;
	background: boolean;
	resume?: {
		journal: JournalCache;
		baseAgentCount: number;
		codeHash: string;
		resumedFrom: string;
		previousPeakParallelAgents?: number;
	};
}

export interface WorkflowRunStatus {
	workflow: string;
	scope: WorkflowScope;
	file: string;
	runId: string;
	runDir: string;
	state: WorkflowRunState;
	background: boolean;
	active: boolean;
	startedAt: string;
	updatedAt: string;
	endedAt?: string;
	elapsedMs: number;
	agentCount: number;
	agentConcurrency?: number;
	maxAgents?: number;
	parallelAgents?: number;
	peakParallelAgents?: number;
	logs: WorkflowLogEntry[];
	lastLog?: WorkflowLogEntry;
	output?: unknown;
	error?: string;
	codeHash?: string;
	cachedCalls?: number;
	resumedFrom?: string;
}

export type WorkflowRunRecord = WorkflowRunResult | WorkflowRunStatus;

export interface ActiveWorkflowRun {
	runId: string;
	runDir: string;
	started: number;
	workflow: WorkflowFile;
	controller: AbortController;
	promise?: Promise<WorkflowRunResult>;
}

export type AgentMonitorState = "running" | "completed" | "failed" | "cached" | "unknown";

export interface AgentMonitorModel {
	id: number;
	name: string;
	state: AgentMonitorState;
	startedAt?: string;
	endedAt?: string;
	elapsedMs?: number;
	ok?: boolean;
	code?: number;
	killed?: boolean;
	artifactPath?: string;
	/** Resolved model the subagent ran with (qualified provider/id when known). */
	model?: string;
	/** Resolved thinking/effort level the subagent ran with. */
	thinking?: string;
	tools?: string[];
	excludeTools?: string[];
	skills?: string[];
	includeSkills?: boolean;
	extensions?: string[];
	includeExtensions?: boolean;
	keys?: string[];
	missingKeys?: string[];
	isolatedEnv?: boolean;
	phaseId?: number;
	phaseIndex?: number;
	phaseTotal?: number;
	phaseLabel?: string;
	promptPreview?: string;
	output?: string;
	schemaOk?: boolean;
	promptAvailable: boolean;
}
