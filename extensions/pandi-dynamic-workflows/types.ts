/**
 * Tipos de contrato compartidos para pandi-dynamic-workflows — las formas de datos que fluyen entre el engine
 * (index.ts) y sus módulos sibling: archivos/ubicaciones/límites de workflow, opciones + resultados de agentes,
 * resultados de bash, entradas de log, la unión de resultado/status/registro de run, registros de journal, runs
 * prepared/active y el modelo agent-monitor. Hoja pura solo de tipos (sin imports, sin runtime), así cualquier módulo
 * puede depender del contrato sin importar el engine. index.ts reexporta esto por back-compat.
 *
 * Extraído byte-idéntico desde index.ts.
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

export interface AgentFocusMetricsSummary {
	turns?: number;
	inputTokensPeak?: number;
	outputTokensTotal?: number;
	totalTokens?: number;
	costTotal?: number;
	toolCalls?: number;
	toolErrors?: number;
	autoRetries?: number;
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
	/** True cuando el presupuesto timeoutMs del agente lo mató (no un abort/pérdida de race). */
	timedOut?: boolean;
	elapsedMs: number;
	/** Espera en la cola del semáforo antes del primer spawn; elapsedMs la incluye. */
	queuedMs?: number;
	prompt: string;
	output: string;
	/** Caracteres del output completo antes del truncado de display/journal. */
	outputChars?: number;
	/** True cuando el output completo es vacío o whitespace-only. */
	outputEmpty?: boolean;
	/** True cuando `output` es una versión truncada del output completo. */
	outputTruncated?: boolean;
	stdout: string;
	stderr: string;
	artifactPath: string;
	/** Modelo resuelto que realmente se pasó al subagente (provider/id calificado cuando se conoce). */
	model?: string;
	/** Nivel thinking/effort resuelto que realmente se pasó al subagente. */
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
	metrics?: AgentFocusMetricsSummary;
}

export interface BashResult {
	ok: boolean;
	code: number;
	killed: boolean;
	elapsedMs: number;
	stdout: string;
	stderr: string;
}

// Resultado de una llamada ask() human-in-the-loop. Se journaliza por (key, occ) como agent/bash para que un
// run reanudado reproduzca la respuesta grabada en vez de volver a preguntar al humano.
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

export interface WorkflowResultIntegrity {
	agentOutputs: {
		observed: number;
		ok: number;
		failed: number;
		empty: number;
		truncated: number;
	};
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
	integrity?: WorkflowResultIntegrity;
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
	integrity?: WorkflowResultIntegrity;
	codeHash?: string;
	cachedCalls?: number;
	resumedFrom?: string;
}

export type WorkflowRunRecord = WorkflowRunResult | WorkflowRunStatus;

export interface ActiveWorkflowRun {
	runId: string;
	runDir: string;
	started: number;
	cwd: string;
	workflow: WorkflowFile;
	limits: RunLimits;
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
	/** Modelo resuelto con el que corrió el subagente (provider/id calificado cuando se conoce). */
	model?: string;
	/** Nivel thinking/effort resuelto con el que corrió el subagente. */
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
	promptCopy?: string;
	promptTruncated?: boolean;
	output?: string;
	outputChars?: number;
	outputEmpty?: boolean;
	outputTruncated?: boolean;
	schemaOk?: boolean;
	metrics?: AgentFocusMetricsSummary;
	promptAvailable: boolean;
}
