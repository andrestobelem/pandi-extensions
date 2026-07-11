/**
 * Tipos de contrato compartidos para pandi-dynamic-workflows — las formas de datos que fluyen entre el engine
 * (index.ts) y sus módulos sibling: definición resuelta de workflow, ubicaciones/límites, opciones + resultados de agentes,
 * resultados de bash, entradas de log, la unión de resultado/status/registro de run, registros de journal, runs
 * prepared/active y el modelo agent-monitor. Hoja pura solo de tipos (sin imports, sin runtime), así cualquier módulo
 * puede depender del contrato sin importar el engine. index.ts reexporta esto por back-compat.
 *
 * Nació como extracción byte-idéntica desde index.ts; ahora es la espina de lenguaje ubicuo del módulo.
 */
export type WorkflowScope = "project" | "global";
export type WorkflowScopeInput = WorkflowScope | "auto";

export type DynamicWorkflowAction =
	| "list"
	| "scaffold"
	| "read"
	| "check"
	| "write"
	| "run"
	| "start"
	| "resume"
	| "cancel"
	| "delete"
	| "graph"
	| "runs"
	| "view"
	| "report";

export interface DynamicWorkflowToolParams {
	action: DynamicWorkflowAction;
	name?: string;
	scope?: WorkflowScopeInput;
	code?: string;
	input?: unknown;
	background?: boolean;
	force?: boolean;
	watch?: boolean;
	concurrency?: number;
	maxAgents?: number;
	timeoutMs?: number;
	agentTimeoutMs?: number;
}

export interface WorkflowDefinition {
	name: string;
	scope: WorkflowScope;
	path: string;
	relativePath: string;
	/** El ejecutable usa directamente un scaffold canónico de la extensión. */
	origin?: "scaffold";
	/** Se puede leer/correr, pero no editar ni borrar. */
	readOnly?: boolean;
}

/** @deprecated Use WorkflowDefinition for the resolved executable workflow definition. */
export type WorkflowFile = WorkflowDefinition;

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

export interface AgentExecutionMetadata {
	id: number;
	name: string;
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
	/** Caracteres del output completo antes del truncado de display/journal. */
	outputChars?: number;
	/** True cuando el output completo es vacío o whitespace-only. */
	outputEmpty?: boolean;
	/** True cuando `output` es una versión truncada del output completo. */
	outputTruncated?: boolean;
	/** True when journaled stdout is bounded; the adjacent .stdout.log remains authoritative. */
	stdoutTruncated?: boolean;
	stdoutChars?: number;
	schemaOk?: boolean;
	metrics?: AgentFocusMetricsSummary;
}

export interface SubagentResult extends AgentExecutionMetadata {
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
	stdout: string;
	stderr: string;
	artifactPath: string;
	data?: unknown;
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

export interface WorkflowIntegritySummary {
	agentResults: number;
	failedAgents: number;
	emptyOutputAgents: number;
	outputTruncatedAgents: number;
	stdoutTruncatedAgents: number;
	timedOutAgents: number;
	schemaFailedAgents: number;
	/** Back-compat for result/status files written by the older output-only summary. */
	agentOutputs?: {
		observed: number;
		ok: number;
		failed: number;
		empty: number;
		truncated: number;
		stdoutTruncated?: number;
		timedOut?: number;
		schemaFailed?: number;
	};
}

/** @deprecated Use WorkflowIntegritySummary. */
export type WorkflowResultIntegrity = WorkflowIntegritySummary;

export type WorkflowRunState = "running" | "completed" | "failed" | "cancelled" | "stale";

export interface WorkflowRunBase {
	workflow: string;
	scope: WorkflowScope;
	file: string;
	runId: string;
	runDir: string;
	startedAt: string;
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

export interface WorkflowRunResult extends WorkflowRunBase {
	ok: boolean;
	state?: Exclude<WorkflowRunState, "running" | "stale">;
	background?: boolean;
	endedAt: string;
}

interface JournalRecordBase {
	v: number;
	key: string;
	occ: number;
	codeHash: string;
	ts: string;
}

type JournalResultByMethod = {
	agent: SubagentResult;
	bash: BashResult;
	ask: AskResult;
};

type JournalMethod = keyof JournalResultByMethod;

type JournalRecordVariant<Method extends JournalMethod> = {
	[CurrentMethod in Method]: {
		method: CurrentMethod;
		result: JournalResultByMethod[CurrentMethod];
	};
}[Method];

export type JournalRecord<Method extends JournalMethod = JournalMethod> = JournalRecordBase &
	JournalRecordVariant<Method>;

export type JournalRecordInput<Method extends JournalMethod = JournalMethod> = Omit<JournalRecordBase, "v" | "ts"> &
	JournalRecordVariant<Method>;

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

export interface WorkflowRunStatus extends WorkflowRunBase {
	state: WorkflowRunState;
	background: boolean;
	active: boolean;
	updatedAt: string;
	endedAt?: string;
	lastLog?: WorkflowLogEntry;
}

export type WorkflowRunRecord = WorkflowRunResult | WorkflowRunStatus;

export interface ActiveWorkflowRun {
	runId: string;
	runDir: string;
	started: number;
	cwd: string;
	workflowDefinition: WorkflowDefinition;
	limits: RunLimits;
	controller: AbortController;
	promise?: Promise<WorkflowRunResult>;
}

export type AgentMonitorState = "running" | "completed" | "failed" | "cached" | "unknown";

export interface AgentMonitorModel extends AgentExecutionMetadata {
	state: AgentMonitorState;
	startedAt?: string;
	endedAt?: string;
	elapsedMs?: number;
	ok?: boolean;
	code?: number;
	killed?: boolean;
	artifactPath?: string;
	promptPreview?: string;
	promptCopy?: string;
	promptTruncated?: boolean;
	output?: string;
	promptAvailable: boolean;
}
