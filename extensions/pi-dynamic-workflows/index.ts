/**
 * Claude-style Dynamic Workflows for Pi.
 *
 * This extension adds:
 * - `dynamic_workflow` tool for the model to list/read/write/run workflow scripts
 * - `/workflow` and `/workflows` commands for humans
 * - `/ultracode` (alias `/dynamic-workflow`) and `/deep-research` routing commands
 * - a small JavaScript workflow runtime with parallel Pi subagents and artifacts
 *
 * Workflows are trusted code. They run inside the Pi process (not a security
 * sandbox) and can spend model calls by spawning subagents.
 */

import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type AgentToolUpdateCallback,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Key, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as crypto from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
	WORKFLOW_PATTERN_CATALOG,
	WORKFLOW_TEMPLATE,
	formatWorkflowCompositionPromptSummary,
	formatWorkflowPatternCatalog,
	formatWorkflowPatternKeyList,
	loadWorkflowPatternCode,
	resolveWorkflowPattern,
	type WorkflowPattern,
} from "./templates.js";
import { notify } from "./notify.js";
import { parsePiJsonModeOutput, parsePiJsonModeOutputLenient } from "./agent-output.js";
import { extractJsonCandidate } from "./json-extract.js";
import {
	buildLimits,
	HARD_MAX_AGENTS,
	HARD_MAX_CONCURRENCY,
	limitParamsFromInput,
	normalizeWorkflowInput,
	parseCliJsonOrText,
} from "./config.js";
import {
	formatElapsedMs,
	formatWorkflowList,
	shortWorkflowName,
	workflowDashboardHint,
	workflowProgress,
} from "./presentation.js";
import { WORKFLOW_WORKER_SOURCE } from "./worker-source.js";
import { renderSafeInline } from "./render-utils.js";
import { phaseEventFields, formatAgentPhase, readRunEvents, readRunLogEvents } from "./event-parser.js";
import {
	abortReasonMessage,
	combineSignal,
	throwIfAborted,
	sleep,
	mapLimit,
	createSemaphore,
	AsyncMutex,
} from "./concurrency-primitives.js";
import {
	normalizeAgentEnvAccess,
	formatAgentAccessMarkdown,
	sanitizeEnvForCache,
	createAgentEnvWrapper,
	applyPersonaOptions,
	applyDefaultAgentAccess,
} from "./agent-env-persona.js";
import {
	makeStructuredOutputSystemPrompt,
	appendSystemPromptOption,
	validateStructuredData,
	formatSchemaRetryPrompt,
} from "./structured-output.js";
import { runStreamingAgentProcess } from "./process-spawn.js";
export { runProcess, runStreamingAgentProcess } from "./process-spawn.js";
import {
	buildWorkflowGraphModelWithSubworkflows,
	renderWorkflowGraphImage,
	renderWorkflowGraphDocumentLines,
	makeWorkflowGraphForContext,
} from "./workflow-graph.js";
import { WorkflowGraphComponent } from "./workflow-graph-component.js";
import { AgentLiveViewComponent } from "./agent-live-view.js";
import { installWorkflowDashboardDownEditor } from "./dashboard-down-editor.js";
import { WorkflowDashboard } from "./workflow-dashboard.js";
import type { WorkflowDashboardTab, DashboardSelection } from "./workflow-dashboard.js";
import { listRuns, formatRunList, selectRunByKey, resolveRun, listRunFiles, formatRunView } from "./run-view.js";
export { selectRunByKey } from "./run-view.js";
export {
	recordValue,
	stringValue,
	numberValue,
	booleanValue,
	stringArrayValue,
	isAgentMonitorState,
	mergeAgentMonitor,
	phaseEventFields,
	getAgentElapsedMs,
	formatAgentPhase,
	readRunEvents,
} from "./event-parser.js";
import { MAX_TOOL_TEXT, safeJson, stringify, text, truncate } from "./format.js";
import {
	appendJournalRecord,
	computeCallKey,
	computeCodeHash,
	loadJournal,
	maxAgentArtifactNumber,
	maxJournalAgentId,
	normalizeBashResultForJournal,
	normalizeSubagentResultForJournal,
} from "./journal.js";
import { getRunDirs, readRunRecord, readRunStatus, writeJsonFile, writeRunStatus } from "./run-store.js";
import {
	formatParallelAgents,
	formatParallelAgentsCompact,
	getRunAgentConcurrency,
	getRunElapsedMs,
	getRunLogs,
	getRunParallelAgents,
	getRunPeakParallelAgents,
	getRunState,
	getRunStatusLabel,
} from "./run-state.js";
export { estimatePeakParallelAgents } from "./run-state.js";

const WORKFLOW_DIR = "workflows";
const WORKFLOW_DRAFT_DIR = path.join(WORKFLOW_DIR, "drafts");
const WORKFLOW_RUN_DIR = path.join(WORKFLOW_DIR, "runs");
const WORKFLOW_GRAPH_DIR = path.join(WORKFLOW_DIR, "graphs");
const PI_LIVE_SESSION_DIR = "live-sessions";
export const PI_SESSION_HEARTBEAT_MS = 5_000;
const PI_SESSION_STALE_MS = 20_000;
// Grace period after SIGTERM before escalating to SIGKILL for spawned child processes.
export const PROCESS_KILL_GRACE_MS = 2_000;
export const MAX_AGENT_OUTPUT_IN_RESULT = 24_000;
const WORKFLOW_STATUS_KEY = "dynamic-workflows";
const WORKFLOW_WIDGET_KEY = "dynamic-workflows";
const ULTRACODE_STATUS_KEY = "dynamic-workflows-ultracode";
const ULTRACODE_CONTRACT_STATUS_KEY = "dynamic-workflows-ultracode-contract";
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

type WorkflowScope = "project" | "global";
type WorkflowScopeInput = WorkflowScope | "auto";

const TOOL_ACTIONS = [
	"list",
	"template",
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

export interface WorkflowFile {
	name: string;
	scope: WorkflowScope;
	path: string;
	relativePath: string;
}

interface WorkflowLocation {
	scope: WorkflowScope;
	root: string;
	trusted: boolean;
	kind: "workflow" | "draft";
}

const RESERVED_WORKFLOW_SUBDIRS = new Set(["drafts", "runs", "graphs", "sessions"]);

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

interface InternalAgentOptions extends AgentOptions {
	__workflowPhase?: AgentPhaseInfo;
	__workflowNamespace?: string;
}

interface AgentSpec extends AgentOptions {
	prompt: string;
}

export const DEFAULT_AGENT_WEB_SEARCH_TOOL = "web_search";
export const DEFAULT_WEB_SEARCH_EXTENSION_PACKAGE = "pi-codex-web-search";
export const DEFAULT_CONTEXT7_SKILL_NAME = "context7-cli";
const READ_ONLY_AGENT_TOOLS = ["read", "grep", "find", "ls"];

export const BUILTIN_AGENT_PERSONAS: Record<string, AgentOptions> = {
	explore: {
		tools: READ_ONLY_AGENT_TOOLS,
		thinking: "medium",
		systemPrompt:
			"Explore broadly but stay evidence-based. Prefer read-only inspection, cite files/lines, and call out uncertainty.",
	},
	reviewer: {
		tools: READ_ONLY_AGENT_TOOLS,
		thinking: "high",
		systemPrompt:
			"Act as a skeptical code reviewer. Look for correctness, security, concurrency, and maintainability risks. Do not edit files; cite concrete evidence.",
	},
	planner: {
		tools: READ_ONLY_AGENT_TOOLS,
		thinking: "high",
		systemPrompt:
			"Act as a careful planner. Decompose the task, identify dependencies and risks, and propose a minimal verifiable plan with clear trade-offs.",
	},
	implementer: {
		tools: READ_ONLY_AGENT_TOOLS,
		thinking: "medium",
		systemPrompt:
			"Act as an implementer designing a concrete patch. Prefer minimal changes, preserve existing behavior, and explain verification steps. Do not edit files unless explicitly allowed by the caller.",
	},
	researcher: {
		tools: READ_ONLY_AGENT_TOOLS,
		thinking: "high",
		systemPrompt:
			"Act as a researcher. Gather independent evidence, compare alternatives, cite sources or files, and separate facts from assumptions.",
	},
};

export const PERSONA_OPTION_KEYS = new Set<keyof AgentOptions>([
	"tools",
	"excludeTools",
	"skills",
	"includeSkills",
	"extensions",
	"model",
	"provider",
	"thinking",
	"includeExtensions",
	"approve",
	"useContextFiles",
	"systemPrompt",
	"appendSystemPrompt",
	"timeoutMs",
	"keys",
	"env",
	"inheritEnv",
]);

export interface SubagentResult {
	id: number;
	name: string;
	ok: boolean;
	code: number;
	killed: boolean;
	elapsedMs: number;
	prompt: string;
	output: string;
	stdout: string;
	stderr: string;
	artifactPath: string;
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
	method: "agent" | "bash";
	codeHash: string;
	ts: string;
	result: SubagentResult | BashResult;
}

export type JournalCache = Map<string, (SubagentResult | BashResult)[]>;

interface PreparedWorkflowRun {
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

interface ActiveWorkflowRun {
	runId: string;
	runDir: string;
	started: number;
	workflow: WorkflowFile;
	controller: AbortController;
	promise?: Promise<WorkflowRunResult>;
}

export const activeRuns = new Map<string, ActiveWorkflowRun>();

interface AppendMutexEntry {
	mutex: AsyncMutex;
	refs: number;
}
const appendFileMutexes = new Map<string, AppendMutexEntry>();

// Acquire the append mutex for a path, ref-counting so the entry survives while any writer is
// using it (preserving mutual exclusion) yet is purged once idle (avoids unbounded map growth).
function acquireAppendMutex(key: string): AsyncMutex {
	let entry = appendFileMutexes.get(key);
	if (!entry) {
		entry = { mutex: new AsyncMutex(), refs: 0 };
		appendFileMutexes.set(key, entry);
	}
	entry.refs++;
	return entry.mutex;
}

function releaseAppendMutex(key: string): void {
	const entry = appendFileMutexes.get(key);
	if (!entry) return;
	entry.refs--;
	if (entry.refs <= 0) appendFileMutexes.delete(key);
}

export function appendFileMutexCount(): number {
	return appendFileMutexes.size;
}

export async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
	const file = path.resolve(filePath);
	const mutex = acquireAppendMutex(file);
	try {
		await mutex.runExclusive(async () => {
			await fs.appendFile(file, `${safeJson(value, 0)}\n`, "utf8");
		});
	} finally {
		releaseAppendMutex(file);
	}
}

interface BashOptions {
	cwd?: string;
	timeoutMs?: number;
	throwOnError?: boolean;
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
			"Workflow operation to perform: list/template/read/write/run/start/resume/cancel/delete/graph/runs/view. template with no name lists the pattern catalog; template with name=<key> returns a pattern scaffold. resume re-runs an interrupted run (stale/failed/cancelled) in place, reusing cached completed subagent/bash calls so they are not re-executed.",
	}),
	name: Type.Optional(
		Type.String({
			description:
				"Workflow name/path relative to the workflow directory (.js is added when omitted), run id for view/cancel/resume (defaults to latest for resume), or pattern key for action=template.",
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
	timeoutMs: Type.Optional(
		Type.Integer({ minimum: 1_000, description: "Overall workflow timeout in milliseconds." }),
	),
	agentTimeoutMs: Type.Optional(
		Type.Integer({
			minimum: 1_000,
			description: "Default timeout for each subagent in milliseconds.",
		}),
	),
});

export function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return slug || "workflow";
}

function normalizeWorkflowName(input: string): string {
	const raw = input.trim().replaceAll("\\", "/");
	if (!raw) throw new Error("Workflow name is required.");
	if (path.isAbsolute(raw)) throw new Error("Workflow name must be relative, not absolute.");
	if (raw.split("/").some((part) => part === "..")) throw new Error("Workflow name must not contain '..'.");
	if (!/^[a-zA-Z0-9._/-]+$/.test(raw)) {
		throw new Error("Workflow name may only contain letters, numbers, '.', '_', '-', and '/'.");
	}
	if (/\.(js|mjs|cjs)$/i.test(raw)) return raw;
	return `${raw}.js`;
}

function workflowDisplayName(relativePath: string): string {
	return relativePath.replace(/\.(js|mjs|cjs)$/i, "");
}

function getLocations(ctx: ExtensionContext): WorkflowLocation[] {
	return [
		{
			scope: "project",
			root: path.join(ctx.cwd, CONFIG_DIR_NAME, WORKFLOW_DRAFT_DIR),
			trusted: ctx.isProjectTrusted(),
			kind: "draft",
		},
		{
			scope: "project",
			root: path.join(ctx.cwd, CONFIG_DIR_NAME, WORKFLOW_DIR),
			trusted: ctx.isProjectTrusted(),
			kind: "workflow",
		},
		{
			scope: "global",
			root: path.join(getAgentDir(), WORKFLOW_DRAFT_DIR),
			trusted: true,
			kind: "draft",
		},
		{
			scope: "global",
			root: path.join(getAgentDir(), WORKFLOW_DIR),
			trusted: true,
			kind: "workflow",
		},
	];
}

function projectHash(cwd: string): string {
	return crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 12);
}

function getGlobalRunRoot(ctx: ExtensionContext): string {
	return path.join(getAgentDir(), WORKFLOW_RUN_DIR, projectHash(ctx.cwd));
}

function getRunRoot(ctx: ExtensionContext): string {
	if (ctx.isProjectTrusted()) return path.join(ctx.cwd, CONFIG_DIR_NAME, WORKFLOW_RUN_DIR);
	return getGlobalRunRoot(ctx);
}

export function getRunRoots(ctx: ExtensionContext): string[] {
	const roots = [getRunRoot(ctx), getGlobalRunRoot(ctx)];
	return [...new Set(roots)];
}

export function getGraphRoot(ctx: ExtensionContext): string {
	if (ctx.isProjectTrusted()) return path.join(ctx.cwd, CONFIG_DIR_NAME, WORKFLOW_GRAPH_DIR);
	return path.join(getAgentDir(), WORKFLOW_GRAPH_DIR, projectHash(ctx.cwd));
}

function getLiveSessionRoot(ctx: ExtensionContext): string {
	if (ctx.isProjectTrusted()) return path.join(ctx.cwd, CONFIG_DIR_NAME, PI_LIVE_SESSION_DIR);
	return path.join(getAgentDir(), PI_LIVE_SESSION_DIR, projectHash(ctx.cwd));
}

function getLiveSessionRoots(ctx: ExtensionContext): string[] {
	const roots = [path.join(getAgentDir(), PI_LIVE_SESSION_DIR, projectHash(ctx.cwd))];
	if (ctx.isProjectTrusted()) roots.unshift(path.join(ctx.cwd, CONFIG_DIR_NAME, PI_LIVE_SESSION_DIR));
	return [...new Set(roots)];
}

function requireTrustedProject(ctx: ExtensionContext): void {
	if (!ctx.isProjectTrusted()) {
		throw new Error(`Project workflows require a trusted project. Run /trust or use scope=global.`);
	}
}

export async function ensureDir(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
}

async function walkWorkflowFiles(
	root: string,
	options: { skipReservedTopLevelDirs?: boolean } = {},
): Promise<string[]> {
	if (!existsSync(root)) return [];
	const out: string[] = [];
	async function walk(dir: string): Promise<void> {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (options.skipReservedTopLevelDirs && dir === root && RESERVED_WORKFLOW_SUBDIRS.has(entry.name)) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
				continue;
			}
			if (entry.isFile() && /\.(js|mjs|cjs)$/i.test(entry.name)) {
				out.push(full);
			}
		}
	}
	await walk(root);
	return out.sort();
}

async function listWorkflows(ctx: ExtensionContext): Promise<WorkflowFile[]> {
	const files: WorkflowFile[] = [];
	for (const location of getLocations(ctx)) {
		if (!location.trusted) continue;
		for (const file of await walkWorkflowFiles(location.root, {
			skipReservedTopLevelDirs: location.kind === "workflow",
		})) {
			const relativePath = path.relative(location.root, file).replaceAll(path.sep, "/");
			files.push({
				name: workflowDisplayName(relativePath),
				scope: location.scope,
				path: file,
				relativePath,
			});
		}
	}
	return files;
}

export async function resolveWorkflow(
	ctx: ExtensionContext,
	name: string,
	scope: WorkflowScopeInput = "auto",
	forWrite: false | "draft" | "workflow" = false,
): Promise<WorkflowFile> {
	const relativePath = normalizeWorkflowName(name);
	const locations = getLocations(ctx);

	if (forWrite) {
		const targetScope: WorkflowScope = scope === "global" ? "global" : "project";
		if (targetScope === "project") requireTrustedProject(ctx);
		const targetKind: WorkflowLocation["kind"] = forWrite;
		const location = locations.find((loc) => loc.scope === targetScope && loc.kind === targetKind)!;
		await ensureDir(location.root);
		const file = resolveInsideRoot(
			location.root,
			path.join(location.root, relativePath),
			relativePath,
			"workflow directory",
		);
		return {
			name: workflowDisplayName(relativePath),
			scope: targetScope,
			path: file,
			relativePath,
		};
	}

	const candidates = scope === "auto" ? locations : locations.filter((loc) => loc.scope === scope);
	for (const location of candidates) {
		if (!location.trusted) continue;
		const file = path.join(location.root, relativePath);
		if (existsSync(file)) {
			const safeFile = resolveInsideRoot(location.root, file, relativePath, "workflow directory");
			return {
				name: workflowDisplayName(relativePath),
				scope: location.scope,
				path: safeFile,
				relativePath,
			};
		}
	}

	if (scope === "project" && !ctx.isProjectTrusted()) requireTrustedProject(ctx);
	throw new Error(`Workflow not found: ${name}`);
}

function parsePatternFlag(raw: string | undefined): string | undefined {
	const value = raw?.trim();
	if (!value) return undefined;
	const match =
		/(?:^|\s)--pattern(?:=|\s+)([^\s]+)/.exec(value) ?? /(?:^|\s)--from-pattern(?:=|\s+)([^\s]+)/.exec(value);
	return match?.[1]?.replace(/^['"]|['"]$/g, "");
}

async function createRunDirectory(
	ctx: ExtensionContext,
	workflowName: string,
	started: number,
): Promise<{ runId: string; runDir: string }> {
	const root = getRunRoot(ctx);
	await ensureDir(root);
	const timestamp = new Date(started).toISOString().replace(/[:.]/g, "-");
	for (let attempt = 0; attempt < 10; attempt++) {
		const runId = `${timestamp}-${slugify(workflowName)}-${crypto.randomBytes(4).toString("hex")}`;
		const runDir = path.join(root, runId);
		try {
			await fs.mkdir(runDir);
			return { runId, runDir };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
	}
	throw new Error("Could not create a unique workflow run directory.");
}

async function prepareWorkflowRun(
	ctx: ExtensionContext,
	workflowName: string,
	background = false,
): Promise<PreparedWorkflowRun> {
	const started = Date.now();
	const { runId, runDir } = await createRunDirectory(ctx, workflowName, started);
	await ensureDir(path.join(runDir, "agents"));
	return { started, runId, runDir, background };
}

function isInsidePath(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return (
		relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
	);
}

function resolveInsideRoot(rootInput: string, resolvedInput: string, displayPath: string, label: string): string {
	const root = path.resolve(rootInput);
	const resolved = path.resolve(resolvedInput);
	if (!isInsidePath(root, resolved)) throw new Error(`Path escapes ${label}: ${displayPath}`);

	const realRoot = realpathSync(root);
	let existing = resolved;
	while (!existsSync(existing)) {
		const parent = path.dirname(existing);
		if (parent === existing) break;
		existing = parent;
	}
	const realExisting = realpathSync(existing);
	if (!isInsidePath(realRoot, realExisting)) throw new Error(`Path escapes ${label} through symlink: ${displayPath}`);
	return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

function resolveCwdPath(cwd: string, filePath: string): string {
	const root = path.resolve(cwd);
	const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
	return resolveInsideRoot(root, resolved, filePath, "workflow cwd");
}

function resolveArtifactPath(runDir: string, name: string): string {
	const normalized = name.trim().replaceAll("\\", "/");
	if (!normalized) throw new Error("Artifact name is required.");
	if (path.isAbsolute(normalized) || normalized.split("/").some((part) => part === "..")) {
		throw new Error("Artifact names must stay inside the workflow run directory.");
	}
	return resolveInsideRoot(runDir, path.join(runDir, normalized), normalized, "workflow run directory");
}

function makeModelArg(ctx: ExtensionContext): string | undefined {
	if (!ctx.model) return undefined;
	return `${ctx.model.provider}/${ctx.model.id}`;
}

export function transformWorkflowCode(code: string): string {
	if (/^\s*import\s/m.test(code)) {
		throw new Error("Static import statements are not supported in workflows. Use ctx helpers instead.");
	}
	let output = code;
	output = output.replace(
		/(^|\n)(\s*)export\s+default\s+async\s+function(\s+[A-Za-z_$][\w$]*)?\s*\(/m,
		(_match, nl, indent, name = "") => `${nl}${indent}module.exports = async function${name}(`,
	);
	output = output.replace(
		/(^|\n)(\s*)export\s+default\s+function(\s+[A-Za-z_$][\w$]*)?\s*\(/m,
		(_match, nl, indent, name = "") => `${nl}${indent}module.exports = function${name}(`,
	);
	output = output.replace(
		/(^|\n)(\s*)export\s+default\s+async\s*\(/m,
		(_match, nl, indent) => `${nl}${indent}module.exports = async (`,
	);
	output = output.replace(
		/(^|\n)(\s*)export\s+default\s*\(/m,
		(_match, nl, indent) => `${nl}${indent}module.exports = (`,
	);
	output = output.replace(
		/(^|\n)(\s*)export\s+default\s+([^;\n]+);?/m,
		(_match, nl, indent, expr) => `${nl}${indent}module.exports = ${expr};`,
	);
	if (/^\s*export\s/m.test(output)) {
		throw new Error(
			"Only `export default` is supported. Prefer `module.exports = async function workflow(ctx, input) {}`.",
		);
	}
	return output;
}

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

		const cleanup = () => {
			signal.removeEventListener("abort", onAbort);
			worker.removeAllListeners();
			void worker.terminate();
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
					const result = await (api[method] as any)(...(message.args ?? []));
					safePost({ type: "response", id: message.id, ok: true, result });
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

function formatRunSummary(result: WorkflowRunResult): string {
	const status = getRunStatusLabel(result);
	const parts = [
		`Workflow ${status}: ${result.workflow}`,
		`Run: ${result.runId}`,
		`State: ${status}${result.background ? " (background)" : ""}`,
		`Agents: ${result.agentCount}`,
		`Parallel agents: ${formatParallelAgents(result)}`,
		`Elapsed: ${Math.round(result.elapsedMs / 1000)}s`,
		`Artifacts: ${result.runDir}`,
	];
	if (result.error) parts.push(`Error: ${result.error}`);
	if (result.output !== undefined) parts.push(`\nOutput:\n${stringify(result.output, MAX_TOOL_TEXT)}`);
	return parts.join("\n");
}

async function showText(ctx: ExtensionContext, title: string, content: string): Promise<void> {
	if (ctx.mode === "print") {
		console.log(content);
		return;
	}
	if (ctx.hasUI) {
		await ctx.ui.editor(title, content);
		return;
	}
	notify(ctx, content, "info");
}

function isActiveRunRecord(run: WorkflowRunRecord): boolean {
	return getRunState(run) === "running" && activeRuns.has(run.runId);
}

export function canCancelRun(run: WorkflowRunRecord): boolean {
	return isActiveRunRecord(run);
}

function setWorkflowIdleStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(WORKFLOW_STATUS_KEY, ctx.ui.theme.fg("dim", "wf · /workflows"));
}

function setWorkflowRunningStatus(
	ctx: ExtensionContext,
	workflowName: string,
	logs: WorkflowLogEntry[],
	status?: WorkflowRunStatus,
): void {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	const { agentsStarted, agentsDone, agentsRunning, bashDone } = workflowProgress(logs);
	const progress = agentsStarted > 0 ? ` ${agentsDone}/${agentsStarted}` : "";
	const parallel = status ? formatParallelAgentsCompact(status) : agentsRunning > 0 ? String(agentsRunning) : "";
	const parallelText = parallel ? ` parallel:${parallel}` : "";
	const bash = bashDone > 0 ? ` bash:${bashDone}` : "";
	ctx.ui.setStatus(
		WORKFLOW_STATUS_KEY,
		`${theme.fg("accent", "▶ wf")} ${theme.fg("dim", shortWorkflowName(workflowName))}${theme.fg("accent", progress)}${theme.fg("dim", `${parallelText}${bash} ${workflowDashboardHint()}`)}`,
	);
}

function setWorkflowFinishedStatus(ctx: ExtensionContext, result: WorkflowRunResult): void {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	const marker = result.ok ? theme.fg("success", "✓ wf") : theme.fg("error", "✗ wf");
	const elapsed = `${Math.round(result.elapsedMs / 1000)}s`;
	ctx.ui.setStatus(
		WORKFLOW_STATUS_KEY,
		`${marker} ${theme.fg("dim", `${shortWorkflowName(result.workflow)} ${elapsed} ${workflowDashboardHint()}`)}`,
	);
}

function setWorkflowErrorStatus(ctx: ExtensionContext, workflowName: string): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(
		WORKFLOW_STATUS_KEY,
		`${ctx.ui.theme.fg("error", "✗ wf")} ${ctx.ui.theme.fg("dim", `${shortWorkflowName(workflowName)} ${workflowDashboardHint()}`)}`,
	);
}

function refreshActiveWorkflowStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const count = activeRuns.size;
	if (count === 0) {
		setWorkflowIdleStatus(ctx);
		return;
	}
	const theme = ctx.ui.theme;
	ctx.ui.setStatus(
		WORKFLOW_STATUS_KEY,
		`${theme.fg("accent", "▶ wf")} ${theme.fg("dim", `${count} bg ${workflowDashboardHint()}`)}`,
	);
}

function clearWorkflowWidget(ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.setWidget(WORKFLOW_WIDGET_KEY, undefined);
}

function formatLiveRunView(
	logs: WorkflowLogEntry[],
	workflowName: string,
	width = 80,
	status?: WorkflowRunStatus,
): string[] {
	if (width <= 0) return [];
	const w = width;
	const { agentsStarted, agentsDone, agentsRunning, bashDone } = workflowProgress(logs);
	const latest = logs.slice(-1)[0];
	const line = (s: string) => truncateToWidth(s, w, "");
	const name = renderSafeInline(shortWorkflowName(workflowName));
	const parallel = status ? formatParallelAgentsCompact(status) : agentsRunning > 0 ? String(agentsRunning) : "0";
	return [
		line(
			`▶ wf ${name}  agents ${agentsDone}/${agentsStarted}  parallel ${parallel}  bash ${bashDone}  logs ${logs.length}`,
		),
		line(
			latest
				? `${latest.time.slice(11, 19)} ${renderSafeInline(latest.message)}  •  ${workflowDashboardHint()}`
				: `Open monitor: ${workflowDashboardHint()}`,
		),
	];
}

function setWorkflowWidget(
	ctx: ExtensionContext,
	workflowName: string,
	logs: WorkflowLogEntry[],
	status?: WorkflowRunStatus,
): void {
	if (!ctx.hasUI) return;
	if (ctx.mode !== "tui") {
		ctx.ui.setWidget(WORKFLOW_WIDGET_KEY, formatLiveRunView(logs, workflowName, undefined, status), {
			placement: "belowEditor",
		});
		return;
	}
	ctx.ui.setWidget(
		WORKFLOW_WIDGET_KEY,
		() => ({
			invalidate(): void {},
			render(width: number): string[] {
				return formatLiveRunView(logs, workflowName, width, status);
			},
		}),
		{ placement: "belowEditor" },
	);
}

type WorkflowGraphStepKind =
	"agent" | "artifact" | "barrier" | "fanout" | "file" | "pipeline" | "shell" | "subworkflow";

export type WorkflowGraphFanoutUnit = "agents" | "branches" | "lanes";

export interface WorkflowGraphFanoutInfo {
	unit: WorkflowGraphFanoutUnit;
	countLabel: string;
	count?: number;
	many: boolean;
	phaseLabel?: string;
	concurrency?: string;
	settle?: boolean;
	stages?: number;
}

export interface WorkflowGraphChildCall {
	method: string;
	kind: WorkflowGraphStepKind;
	symbol: string;
	title: string;
	label: string;
	line: number;
	firstArg?: string;
}

export interface WorkflowGraphStep {
	index: number;
	method: string;
	kind: WorkflowGraphStepKind;
	symbol: string;
	title: string;
	label: string;
	line: number;
	firstArg?: string;
	children: WorkflowGraphChildCall[];
	fanout?: WorkflowGraphFanoutInfo;
	subworkflow?: WorkflowGraphModel;
	subworkflowError?: string;
}

export interface WorkflowGraphCall extends WorkflowGraphChildCall {
	start: number;
	end: number;
	snippet: string;
}

export interface WorkflowGraphModel {
	workflow: WorkflowFile;
	steps: WorkflowGraphStep[];
	notes: string[];
}

export interface WorkflowGraphRenderTheme {
	accent(text: string): string;
	muted(text: string): string;
	success(text: string): string;
	warning(text: string): string;
}

async function showWorkflowGraph(ctx: ExtensionContext, workflow: WorkflowFile, code: string): Promise<void> {
	const model = await buildWorkflowGraphModelWithSubworkflows(ctx, workflow, code);
	if (ctx.mode === "print") {
		console.log(renderWorkflowGraphDocumentLines(model, 120).join("\n"));
		return;
	}
	if (ctx.mode === "tui") {
		const imageAttempt = await renderWorkflowGraphImage(ctx, model).catch((err) => ({
			warning: err instanceof Error ? err.message : String(err),
		}));
		await ctx.ui.custom<void>(
			(_tui, theme, _keybindings, done) =>
				new WorkflowGraphComponent(model, theme, () => done(undefined), imageAttempt),
		);
		return;
	}
	if (ctx.hasUI) {
		await ctx.ui.editor(
			`Workflow graph: ${workflow.name}`,
			renderWorkflowGraphDocumentLines(model, 120).join("\n"),
		);
		return;
	}
	notify(ctx, renderWorkflowGraphDocumentLines(model, 100).join("\n"), "info");
}

function resolveAgentArtifactPath(run: WorkflowRunRecord, agent: AgentMonitorModel): string | undefined {
	if (!agent.artifactPath) return undefined;
	return path.isAbsolute(agent.artifactPath) ? agent.artifactPath : path.join(run.runDir, agent.artifactPath);
}

function resolveAgentLiveStreamPath(artifactPath: string | undefined, stream: "stdout" | "stderr"): string | undefined {
	if (!artifactPath) return undefined;
	return artifactPath.endsWith(".md")
		? artifactPath.slice(0, -3) + `.${stream}.log`
		: `${artifactPath}.${stream}.log`;
}

export function extractMarkdownSection(markdown: string, heading: string): string | undefined {
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const knownHeadings = ["Access", "Prompt", "Structured Output", "Stdout", "Stderr"];
	const nextHeadings = knownHeadings
		.filter((candidate) => candidate !== heading)
		.map((candidate) => candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	const nextPattern = nextHeadings.length ? `\\n## (?:${nextHeadings.join("|")})\\n` : "$^";
	const match = new RegExp(`(?:^|\\n)## ${escaped}\\n\\n([\\s\\S]*?)(?=${nextPattern}|$)`).exec(markdown);
	return match?.[1]?.trim();
}

function fencedBlock(content: string, lang = "text"): string {
	const fence = content.includes("```") ? "````" : "```";
	return `${fence}${lang}\n${content}\n${fence}`;
}

async function formatAgentView(run: WorkflowRunRecord, agent: AgentMonitorModel): Promise<string> {
	const artifactPath = resolveAgentArtifactPath(run, agent);
	let artifactBody = "";
	let artifactError = "";
	if (artifactPath) {
		try {
			artifactBody = await fs.readFile(artifactPath, "utf8");
		} catch (err) {
			artifactError = err instanceof Error ? err.message : String(err);
		}
	}
	const access = artifactBody ? extractMarkdownSection(artifactBody, "Access") : undefined;
	const prompt = artifactBody ? extractMarkdownSection(artifactBody, "Prompt") : undefined;
	const stdout = artifactBody ? extractMarkdownSection(artifactBody, "Stdout") : undefined;
	const stderr = artifactBody ? extractMarkdownSection(artifactBody, "Stderr") : undefined;
	const structuredOutput = artifactBody ? extractMarkdownSection(artifactBody, "Structured Output") : undefined;
	const liveStdoutPath = resolveAgentLiveStreamPath(artifactPath, "stdout");
	const liveStderrPath = resolveAgentLiveStreamPath(artifactPath, "stderr");
	let liveStdout = "";
	let liveStderr = "";
	if (liveStdoutPath && !stdout) liveStdout = await fs.readFile(liveStdoutPath, "utf8").catch(() => "");
	if (liveStderrPath && !stderr) liveStderr = await fs.readFile(liveStderrPath, "utf8").catch(() => "");
	const stdoutForParsing = stdout || liveStdout;
	const parsedStdout = stdout
		? parsePiJsonModeOutput(stdout)
		: liveStdout
			? parsePiJsonModeOutputLenient(liveStdout)
			: undefined;
	const modelOutput = agent.output || (parsedStdout?.ok ? parsedStdout.output : undefined);
	const stdoutNote = stdoutForParsing
		? parsedStdout?.ok
			? `${stdout ? "Raw" : "Live"} stdout is a Pi JSON event stream; parsed assistant output is shown above and raw stdout is omitted.`
			: `${stdout ? "Raw" : "Live"} stdout could not be parsed as Pi JSON (${parsedStdout?.warning ?? "unknown reason"}); see the artifact/live stream path if you need the raw stream.`
		: undefined;
	const promptText = prompt
		? truncate(prompt, 12_000)
		: agent.promptAvailable
			? "Prompt artifact exists, but the prompt section could not be parsed."
			: "Prompt not available for this run/agent.";
	const stateIcon =
		agent.state === "completed"
			? "✅"
			: agent.state === "running"
				? "▶️"
				: agent.state === "cached"
					? "♻️"
					: agent.state === "failed"
						? "❌"
						: "?";
	const phase = formatAgentPhase(agent);
	const outputText = modelOutput
		? truncate(modelOutput, MAX_TOOL_TEXT)
		: agent.state === "running"
			? "Agent is still running. The parsed answer will appear here when it finishes."
			: "No parsed answer was recorded. Check Diagnostics and the artifact path below if you need the raw stdout/stderr.";
	const accessFallback = [
		`- tools: ${agent.tools?.length ? agent.tools.join(", ") : "default"}`,
		`- excludeTools: ${agent.excludeTools?.length ? agent.excludeTools.join(", ") : "none"}`,
		`- skills: ${agent.skills?.length ? `${agent.skills.join(", ")}${agent.includeSkills ? " + discovery" : " (explicit only)"}` : agent.includeSkills === false ? "disabled" : "default discovery"}`,
		`- extensions: ${agent.extensions?.length ? `${agent.extensions.join(", ")}${agent.includeExtensions ? " + discovery" : " (explicit only)"}` : agent.includeExtensions ? "default discovery" : "disabled"}`,
		`- keys: ${agent.keys?.length ? `${agent.keys.join(", ")} (values redacted)` : agent.isolatedEnv ? "none selected" : "default inherited environment"}`,
		...(agent.missingKeys?.length ? [`- missingKeys: ${agent.missingKeys.join(", ")}`] : []),
		...(agent.isolatedEnv === undefined
			? []
			: [`- env: ${agent.isolatedEnv ? "isolated + selected keys" : "process default/inherited"}`]),
	].join("\n");
	const summary = [
		`- Agent: #${agent.id}${phase ? ` ${phase}` : ""} ${agent.name}`,
		`- State: ${stateIcon} ${agent.state}`,
		...(phase ? [`- Phase: ${phase}${agent.phaseLabel ? ` (${agent.phaseLabel})` : ""}`] : []),
		`- Workflow: ${run.workflow}`,
		`- Run: ${run.runId}`,
		...(agent.startedAt ? [`- Started: ${agent.startedAt}`] : []),
		...(agent.endedAt ? [`- Ended: ${agent.endedAt}`] : []),
		...(agent.elapsedMs !== undefined ? [`- Elapsed: ${formatElapsedMs(agent.elapsedMs)}`] : []),
		...(agent.ok !== undefined ? [`- OK: ${agent.ok}`] : []),
		...(agent.code !== undefined ? [`- Exit code: ${agent.code}`] : []),
		...(agent.killed !== undefined ? [`- Killed: ${agent.killed}`] : []),
		...(agent.schemaOk !== undefined ? [`- Schema OK: ${agent.schemaOk}`] : []),
		`- Artifact: ${artifactPath ?? "unavailable"}`,
		...(artifactError ? [`- Artifact read error: ${artifactError}`] : []),
	];
	return [
		`# Agent #${agent.id}${phase ? ` ${phase}` : ""}: ${agent.name}`,
		"",
		"## Summary",
		"",
		...summary,
		"",
		"## Agent answer",
		"",
		"Best available agent text. Raw Pi JSON stdout is hidden when it parses cleanly; otherwise see Diagnostics/artifact.",
		"",
		outputText,
		...(structuredOutput
			? ["", "## Structured output", "", fencedBlock(truncate(structuredOutput, MAX_TOOL_TEXT), "text")]
			: []),
		"",
		"## Prompt sent to this agent",
		"",
		prompt ? fencedBlock(promptText, "text") : promptText,
		"",
		"## Runtime access",
		"",
		access ? truncate(access, 6000) : accessFallback,
		"",
		"## Diagnostics",
		"",
		...(stdoutNote ? [`- stdout: ${stdoutNote}`] : ["- stdout: not recorded yet."]),
		...(liveStdoutPath ? [`- live stdout: ${liveStdoutPath}`] : []),
		...(liveStderrPath ? [`- live stderr: ${liveStderrPath}`] : []),
		...(stderr || liveStderr
			? ["", "### stderr", "", fencedBlock(truncate(stderr || liveStderr, 6000), "text")]
			: []),
	].join("\n");
}

const TERMINAL_AGENT_STATES: ReadonlySet<string> = new Set(["completed", "failed", "cached"]);

function isTerminalAgentState(state: string | undefined): boolean {
	return state !== undefined && TERMINAL_AGENT_STATES.has(state);
}

// Header status label for the live agent viewer: keep advertising the 1s poll
// only while the agent can still change; show a stable "final" marker once it
// reaches a terminal state (and the poll is stopped).
export function liveAgentHeaderStatus(state: string | undefined): string {
	return isTerminalAgentState(state) ? `final (${state})` : "refresh 1s";
}

async function latestAgentForRun(run: WorkflowRunRecord, agent: AgentMonitorModel): Promise<AgentMonitorModel> {
	const { agents } = await readRunEvents(run.runDir);
	return agents.find((candidate) => candidate.id === agent.id) ?? agent;
}

async function showLiveAgentView(
	ctx: ExtensionContext,
	run: WorkflowRunRecord,
	agent: AgentMonitorModel,
): Promise<void> {
	if (ctx.mode === "print") {
		console.log(await formatAgentView(run, await latestAgentForRun(run, agent)));
		return;
	}
	if (ctx.mode === "tui") {
		let timer: NodeJS.Timeout | undefined;
		let refreshing = false;
		let component: AgentLiveViewComponent | undefined;
		try {
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				component = new AgentLiveViewComponent(
					theme,
					() => tui.terminal.rows,
					() => done(undefined),
					() => tui.requestRender(),
				);
				const refresh = async () => {
					if (refreshing || !component) return;
					refreshing = true;
					try {
						const latest = await latestAgentForRun(run, agent);
						component.setContent(await formatAgentView(run, latest), latest.state);
						tui.requestRender();
						// Stop polling once the agent is terminal; the final output stays
						// on screen until the user closes the view.
						if (timer && isTerminalAgentState(latest.state)) {
							clearInterval(timer);
							timer = undefined;
						}
					} finally {
						refreshing = false;
					}
				};
				timer = setInterval(() => void refresh(), 1000);
				void refresh();
				return component;
			});
		} finally {
			if (timer) clearInterval(timer);
		}
		return;
	}
	if (ctx.hasUI) {
		await ctx.ui.editor(
			`Workflow agent: ${agent.name}`,
			await formatAgentView(run, await latestAgentForRun(run, agent)),
		);
		return;
	}
	notify(ctx, await formatAgentView(run, await latestAgentForRun(run, agent)), "info");
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

export interface WorkflowDashboardResult {
	type:
		| "agent"
		| "graph"
		| "run"
		| "view"
		| "cancel"
		| "rerun"
		| "deleteWorkflow"
		| "deleteRun"
		| "newPattern"
		| "switchSession";
	workflow?: WorkflowFile;
	run?: WorkflowRunRecord;
	agent?: AgentMonitorModel;
	pattern?: WorkflowPattern;
	session?: PiSessionModel;
}

export interface WorkflowAgentEntry {
	run: WorkflowRunRecord;
	agent: AgentMonitorModel;
}

export interface WorkflowActivityEntry {
	time: string;
	workflow: string;
	runId: string;
	state: WorkflowRunState;
	message: string;
	details?: unknown;
}

interface PiSessionRecord {
	id: string;
	pid: number;
	mode: string;
	cwd: string;
	startedAt: string;
	updatedAt: string;
	reason?: string;
	sessionId?: string;
	sessionFile?: string;
	sessionName?: string;
	trusted?: boolean;
	idle?: boolean;
	activeWorkflowRuns?: number;
}

export interface PiSessionModel extends PiSessionRecord {
	file: string;
	live: boolean;
	current: boolean;
	ageMs: number;
	staleReason?: string;
}

interface LivePiSessionRuntime {
	id: string;
	ctx: ExtensionContext;
	file: string;
	startedAt: string;
	reason: string;
	timer?: NodeJS.Timeout;
}

let livePiSession: LivePiSessionRuntime | undefined;

function isPersistentPiSessionMode(mode: string): boolean {
	return mode === "tui" || mode === "rpc";
}

function sessionManagerMetadata(ctx: ExtensionContext): {
	sessionId?: string;
	sessionFile?: string;
	sessionName?: string;
} {
	const manager = ctx.sessionManager as unknown as {
		getSessionId?: () => string;
		getSessionFile?: () => string | undefined;
		getSessionName?: () => string | undefined;
	};
	return {
		sessionId: manager.getSessionId?.(),
		sessionFile: manager.getSessionFile?.(),
		sessionName: manager.getSessionName?.(),
	};
}

function buildPiSessionRecord(runtime: LivePiSessionRuntime): PiSessionRecord {
	const { ctx } = runtime;
	const metadata = sessionManagerMetadata(ctx);
	return {
		id: runtime.id,
		pid: process.pid,
		mode: ctx.mode,
		cwd: ctx.cwd,
		startedAt: runtime.startedAt,
		updatedAt: new Date().toISOString(),
		reason: runtime.reason,
		...metadata,
		trusted: ctx.isProjectTrusted(),
		idle: ctx.isIdle(),
		activeWorkflowRuns: activeRuns.size,
	};
}

async function writePiSessionHeartbeat(runtime: LivePiSessionRuntime): Promise<void> {
	try {
		await ensureDir(path.dirname(runtime.file));
		await writeJsonFile(runtime.file, buildPiSessionRecord(runtime));
	} catch {
		// Heartbeats are best-effort; the dashboard should never fail because the
		// live-session registry cannot be written (e.g. permissions or tmp cleanup).
	}
}

async function startPiSessionHeartbeat(event: { reason: string }, ctx: ExtensionContext): Promise<void> {
	await stopPiSessionHeartbeat();
	if (!isPersistentPiSessionMode(ctx.mode)) return;
	const id = `${Date.now().toString(36)}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
	const runtime: LivePiSessionRuntime = {
		id,
		ctx,
		file: path.join(getLiveSessionRoot(ctx), `${id}.json`),
		startedAt: new Date().toISOString(),
		reason: event.reason,
	};
	livePiSession = runtime;
	await writePiSessionHeartbeat(runtime);
	runtime.timer = setInterval(() => void writePiSessionHeartbeat(runtime), PI_SESSION_HEARTBEAT_MS);
	runtime.timer.unref?.();
}

async function stopPiSessionHeartbeat(): Promise<void> {
	const runtime = livePiSession;
	livePiSession = undefined;
	if (!runtime) return;
	if (runtime.timer) clearInterval(runtime.timer);
	await fs.rm(runtime.file, { force: true }).catch(() => undefined);
}

function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function parsePiSessionRecord(value: unknown): PiSessionRecord | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.id !== "string" || typeof record.cwd !== "string" || typeof record.mode !== "string")
		return undefined;
	if (typeof record.startedAt !== "string" || typeof record.updatedAt !== "string") return undefined;
	if (typeof record.pid !== "number" || !Number.isInteger(record.pid)) return undefined;
	return {
		id: record.id,
		pid: record.pid,
		mode: record.mode,
		cwd: record.cwd,
		startedAt: record.startedAt,
		updatedAt: record.updatedAt,
		...(typeof record.reason === "string" ? { reason: record.reason } : {}),
		...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
		...(typeof record.sessionFile === "string" ? { sessionFile: record.sessionFile } : {}),
		...(typeof record.sessionName === "string" ? { sessionName: record.sessionName } : {}),
		...(typeof record.trusted === "boolean" ? { trusted: record.trusted } : {}),
		...(typeof record.idle === "boolean" ? { idle: record.idle } : {}),
		...(typeof record.activeWorkflowRuns === "number" && Number.isFinite(record.activeWorkflowRuns)
			? { activeWorkflowRuns: record.activeWorkflowRuns }
			: {}),
	};
}

async function readPiSessionRecord(file: string): Promise<PiSessionRecord | undefined> {
	try {
		return parsePiSessionRecord(JSON.parse(await fs.readFile(file, "utf8")));
	} catch {
		return undefined;
	}
}

async function collectPiSessions(ctx: ExtensionContext): Promise<PiSessionModel[]> {
	const now = Date.now();
	const byId = new Map<string, PiSessionModel>();
	for (const root of getLiveSessionRoots(ctx)) {
		if (!existsSync(root)) continue;
		let entries: import("node:fs").Dirent[];
		try {
			entries = await fs.readdir(root, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const file = path.join(root, entry.name);
			const record = await readPiSessionRecord(file);
			if (record?.cwd !== ctx.cwd || !isPersistentPiSessionMode(record.mode)) continue;
			const updatedMs = Date.parse(record.updatedAt);
			const ageMs = Number.isFinite(updatedMs) ? Math.max(0, now - updatedMs) : Number.POSITIVE_INFINITY;
			const pidAlive = isPidAlive(record.pid);
			const fresh = Number.isFinite(ageMs) && ageMs <= PI_SESSION_STALE_MS;
			const live = pidAlive && fresh;
			const staleReason = live ? undefined : !pidAlive ? "pid exited" : !fresh ? "heartbeat stale" : "unknown";
			const model: PiSessionModel = {
				...record,
				file,
				live,
				current: record.id === livePiSession?.id,
				ageMs,
				...(staleReason ? { staleReason } : {}),
			};
			const previous = byId.get(record.id);
			if (!previous || model.live || model.ageMs < previous.ageMs) byId.set(record.id, model);
		}
	}
	return [...byId.values()].sort((a, b) => {
		if (a.current !== b.current) return a.current ? -1 : 1;
		if (a.live !== b.live) return a.live ? -1 : 1;
		return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
	});
}

function formatPiSessionList(sessions: PiSessionModel[]): string {
	if (sessions.length === 0) return "No live Pi TUI/RPC sessions found for this project.";
	const lines = [`Pi sessions (${sessions.length})`];
	for (const session of sessions) {
		const status = session.live ? "live" : `stale${session.staleReason ? `:${session.staleReason}` : ""}`;
		const age = Number.isFinite(session.ageMs) ? `${formatElapsedMs(session.ageMs)} ago` : "unknown";
		lines.push(
			`- ${status} ${session.mode} pid:${session.pid}${session.current ? " this" : ""}${session.sessionName ? ` name:${session.sessionName}` : ""} updated:${age} idle:${session.idle === undefined ? "unknown" : session.idle ? "yes" : "no"} workflows:${session.activeWorkflowRuns ?? 0}`,
		);
		lines.push(`  session: ${session.sessionId ?? "unknown"}`);
		if (session.sessionFile) lines.push(`  file: ${session.sessionFile}`);
	}
	return lines.join("\n");
}

async function collectWorkflowActivity(
	runs: WorkflowRunRecord[],
	maxRuns = 12,
	maxEntries = 80,
): Promise<WorkflowActivityEntry[]> {
	const entries: WorkflowActivityEntry[] = [];
	for (const run of runs.slice(0, maxRuns)) {
		const logs = getRunLogs(run).length > 0 ? getRunLogs(run) : await readRunLogEvents(run.runDir);
		for (const logEntry of logs.slice(-20)) {
			entries.push({
				time: logEntry.time,
				workflow: run.workflow,
				runId: run.runId,
				state: getRunState(run),
				message: logEntry.message,
				...(logEntry.details === undefined ? {} : { details: logEntry.details }),
			});
		}
	}
	return entries.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, maxEntries);
}

async function collectWorkflowAgents(runs: WorkflowRunRecord[]): Promise<WorkflowAgentEntry[]> {
	const entries: WorkflowAgentEntry[] = [];
	const runOrder = new Map(runs.map((run, index) => [run.runId, index]));
	for (const run of runs) {
		const { agents } = await readRunEvents(run.runDir);
		for (const agent of agents) entries.push({ run, agent });
	}
	return entries.sort((a, b) => {
		const byRun = (runOrder.get(a.run.runId) ?? 0) - (runOrder.get(b.run.runId) ?? 0);
		if (byRun !== 0) return byRun;
		return a.agent.id - b.agent.id;
	});
}

export function compactInline(value: unknown, maxChars = 160): string {
	return stringify(value, maxChars).replace(/\s+/g, " ").trim();
}

export interface WorkflowMonitorModel {
	run: WorkflowRunRecord;
	workflow: string;
	runId: string;
	state: WorkflowRunState;
	active: boolean;
	stale: boolean;
	elapsedMs: number;
	agentsStarted: number;
	agentsDone: number;
	parallelAgents: number;
	peakParallelAgents?: number;
	agentConcurrency?: number;
	bashDone: number;
	artifactCount: number;
	agents: AgentMonitorModel[];
	lastLog?: WorkflowLogEntry;
	runDir: string;
	priority: "active" | "latest";
	canCancel: boolean;
	canRerun: boolean;
}

async function countRunArtifacts(runDir: string): Promise<number> {
	try {
		const files = await listRunFiles(runDir, 200);
		const bookkeeping = new Set([
			"status.json",
			"result.json",
			"input.json",
			"events.jsonl",
			JOURNAL_FILE,
			"summary.md",
		]);
		return files.filter((file) => !bookkeeping.has(file)).length;
	} catch {
		return 0;
	}
}

export function canRerunRun(run: WorkflowRunRecord): boolean {
	return getRunState(run) !== "running" && !!run.file && existsSync(run.file);
}

async function deriveWorkflowMonitor(
	run: WorkflowRunRecord,
	priority: "active" | "latest",
): Promise<WorkflowMonitorModel> {
	const state = getRunState(run);
	const parsedEvents = await readRunEvents(run.runDir);
	const logs = getRunLogs(run).length > 0 ? getRunLogs(run) : parsedEvents.logs;
	const { agentsStarted, agentsDone, bashDone } = workflowProgress(logs);
	const active = isActiveRunRecord(run);
	const lastLog = logs.slice(-1)[0];
	const peakParallelAgents = getRunPeakParallelAgents(run, parsedEvents.agents);
	return {
		run,
		workflow: run.workflow,
		runId: run.runId,
		state,
		active,
		stale: state === "stale" || (state === "running" && !active),
		elapsedMs: getRunElapsedMs(run, state),
		agentsStarted: Math.max(agentsStarted, run.agentCount, parsedEvents.agents.length),
		agentsDone: Math.max(
			agentsDone,
			parsedEvents.agents.filter(
				(agent) => agent.state === "completed" || agent.state === "failed" || agent.state === "cached",
			).length,
		),
		parallelAgents: getRunParallelAgents(run, parsedEvents.agents),
		...(peakParallelAgents === undefined ? {} : { peakParallelAgents }),
		...(getRunAgentConcurrency(run) === undefined ? {} : { agentConcurrency: getRunAgentConcurrency(run) }),
		bashDone,
		artifactCount: await countRunArtifacts(run.runDir),
		agents: parsedEvents.agents,
		...(lastLog ? { lastLog } : {}),
		runDir: run.runDir,
		priority,
		canCancel: canCancelRun(run),
		canRerun: canRerunRun(run),
	};
}

async function deriveWorkflowMonitorModels(runs: WorkflowRunRecord[]): Promise<WorkflowMonitorModel[]> {
	// Surface ALL active runs (the header advertises "▶ N active"); fall back to the
	// latest run only when nothing is active. The Monitor lets the user switch focus.
	const actives = runs.filter((run) => isActiveRunRecord(run));
	if (actives.length > 0) return Promise.all(actives.map((run) => deriveWorkflowMonitor(run, "active")));
	const latest = runs[0];
	if (!latest) return [];
	return [await deriveWorkflowMonitor(latest, "latest")];
}

async function runWorkflowWithUi(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	workflow: WorkflowFile,
	input: unknown,
	limits: RunLimits,
	signal: AbortSignal | undefined,
	onProgress?: (logs: WorkflowLogEntry[], status?: WorkflowRunStatus) => void,
	prepared?: PreparedWorkflowRun,
): Promise<WorkflowRunResult> {
	if (ctx.hasUI) {
		setWorkflowRunningStatus(ctx, workflow.name, []);
		setWorkflowWidget(ctx, workflow.name, []);
	}
	try {
		const result = await runWorkflow(
			pi,
			ctx,
			workflow,
			input,
			limits,
			signal,
			(logs, status) => {
				onProgress?.(logs, status);
				if (ctx.hasUI) {
					setWorkflowRunningStatus(ctx, workflow.name, logs, status);
					setWorkflowWidget(ctx, workflow.name, logs, status);
				}
			},
			prepared,
		);
		setWorkflowFinishedStatus(ctx, result);
		return result;
	} catch (err) {
		setWorkflowErrorStatus(ctx, workflow.name);
		throw err;
	} finally {
		clearWorkflowWidget(ctx);
	}
}

async function runWorkflowFromUi(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	workflow: WorkflowFile,
	input: unknown,
): Promise<WorkflowRunRecord> {
	const limits = buildLimits(limitParamsFromInput(input));
	if (shouldLaunchWorkflowInBackground(ctx)) {
		const status = await startWorkflowBackground(pi, ctx, workflow, input, limits);
		notify(ctx, formatBackgroundStart(status), "info");
		return status;
	}
	const result = await runWorkflowWithUi(pi, ctx, workflow, input, limits, undefined);
	notify(ctx, formatRunSummary(result), result.ok ? "info" : "error");
	return result;
}

async function resolveWorkflowForRun(ctx: ExtensionContext, run: WorkflowRunRecord): Promise<WorkflowFile | undefined> {
	try {
		return await resolveWorkflow(ctx, run.workflow, run.scope);
	} catch {
		if (run.file && existsSync(run.file)) {
			return {
				name: run.workflow,
				scope: run.scope,
				path: run.file,
				relativePath: path.basename(run.file),
			};
		}
		return undefined;
	}
}

async function loadRerunInput(
	ctx: ExtensionContext,
	run: WorkflowRunRecord,
): Promise<{ input: unknown; source: string } | undefined> {
	const inputPath = path.join(run.runDir, "input.json");
	let textValue: string;
	let source = inputPath;
	try {
		textValue = await fs.readFile(inputPath, "utf8");
	} catch {
		const edited = await ctx.ui.editor(`Workflow input JSON: ${run.workflow}`, "{}");
		if (edited === undefined) return undefined;
		textValue = edited;
		source = "editor JSON (input.json missing)";
	}
	try {
		return { input: parseCliJsonOrText(textValue, { strictJson: true }), source };
	} catch {
		const edited = await ctx.ui.editor(`Fix workflow input JSON: ${run.workflow}`, textValue);
		if (edited === undefined) return undefined;
		return { input: parseCliJsonOrText(edited, { strictJson: true }), source: "editor JSON" };
	}
}

export type DashboardCommandSubmitter = (command: string) => void;
export type DashboardOpener = (submitCommand?: DashboardCommandSubmitter) => Promise<void>;

async function createWorkflowDraftFromPattern(
	ctx: ExtensionContext,
	pattern: WorkflowPattern,
): Promise<WorkflowFile | undefined> {
	const nameText = await ctx.ui.editor("Workflow name", pattern.defaultName);
	const name = nameText?.trim();
	if (!name) return undefined;
	const code = await loadWorkflowPatternCode(pattern);
	const edited = await ctx.ui.editor(`New workflow from pattern: ${pattern.key}`, code);
	if (edited === undefined) return undefined;
	const workflow = await resolveWorkflow(ctx, name, "project", "draft");
	if (existsSync(workflow.path)) {
		const ok = await ctx.ui.confirm("Overwrite existing workflow?", `${workflow.name}\n${workflow.path}`);
		if (!ok) return undefined;
	}
	await ensureDir(path.dirname(workflow.path));
	await fs.writeFile(workflow.path, edited, "utf8");
	return workflow;
}

interface WorkflowDashboardOpenOptions {
	submitCommand?: DashboardCommandSubmitter;
}

type SwitchableSessionContext = ExtensionContext & {
	switchSession?: (
		sessionPath: string,
		options?: {
			withSession?: (ctx: {
				ui: { notify?: (message: string, kind?: "info" | "warning" | "error") => void };
			}) => Promise<void> | void;
		},
	) => Promise<{ cancelled: boolean }>;
};

function quoteWorkflowCommandArgument(value: string): string {
	return JSON.stringify(value);
}

function parseWorkflowCommandArgument(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith('"')) {
		try {
			const parsed = JSON.parse(trimmed);
			if (typeof parsed === "string") return parsed;
		} catch {
			return undefined;
		}
	}
	return trimmed;
}

async function switchToPiSession(
	ctx: ExtensionContext,
	session: PiSessionModel,
	options: WorkflowDashboardOpenOptions = {},
): Promise<void> {
	const sessionFile = session.sessionFile;
	if (!sessionFile) {
		notify(ctx, "Cannot switch: selected Pi session did not record a session file.", "warning");
		return;
	}
	const currentFile = sessionManagerMetadata(ctx).sessionFile;
	if (currentFile && path.resolve(currentFile) === path.resolve(sessionFile)) {
		notify(ctx, "Already in the selected Pi session.", "info");
		return;
	}
	const switchSession = (ctx as SwitchableSessionContext).switchSession;
	if (typeof switchSession !== "function") {
		if (options.submitCommand) {
			options.submitCommand(`/workflow switch-session ${quoteWorkflowCommandArgument(sessionFile)}`);
			return;
		}
		notify(
			ctx,
			"Cannot switch from this dashboard context. Open it from the prompt with /workflow sessions.",
			"warning",
		);
		return;
	}
	if (!existsSync(sessionFile)) {
		notify(ctx, `Cannot switch: session file no longer exists: ${sessionFile}`, "warning");
		return;
	}
	const label = session.sessionName || session.sessionId || path.basename(sessionFile);
	const activeWarning =
		activeRuns.size > 0
			? `\n\nWarning: ${activeRuns.size} active workflow run(s) in this Pi will be cancelled by the session switch.`
			: "";
	const pidLine =
		session.pid > 0
			? `\nPID: ${session.pid}${session.live ? " (live)" : session.staleReason ? ` (${session.staleReason})` : ""}`
			: "";
	const ok = await ctx.ui.confirm(
		"Switch Pi session?",
		`Target: ${label}\nFile: ${sessionFile}${pidLine}\n\nThis replaces the current conversation view. If another Pi process is still using this file, both processes may append to the same session.${activeWarning}`,
	);
	if (!ok) return;
	const result = await switchSession(sessionFile, {
		withSession: async (nextCtx) => {
			nextCtx.ui.notify?.(`Switched to Pi session: ${label}`, "info");
		},
	});
	if (result.cancelled) notify(ctx, "Session switch cancelled.", "warning");
}

export async function openWorkflowDashboard(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	initialTab: WorkflowDashboardTab = "monitor",
	options: WorkflowDashboardOpenOptions = {},
): Promise<void> {
	if (ctx.mode !== "tui") {
		notify(
			ctx,
			"Workflow dashboard requires TUI mode. Use /workflow list, /workflow graph, /workflow runs, or /workflow view.",
			"warning",
		);
		return;
	}
	let currentTab = initialTab;
	let restore: DashboardSelection | undefined;
	// Reopen loop: non-terminal actions (view/graph/agent/cancel/delete/rerun/run)
	// return to the dashboard on the same tab/selection instead of dropping to the
	// editor. Only switching session, creating a pattern draft, or q/esc exit.
	for (;;) {
		const workflows = await listWorkflows(ctx);
		const runs = await listRuns(ctx);
		const [activity, piSessions, monitorModels, agentEntries] = await Promise.all([
			collectWorkflowActivity(runs),
			collectPiSessions(ctx),
			deriveWorkflowMonitorModels(runs),
			collectWorkflowAgents(runs),
		]);
		let refreshTimer: NodeJS.Timeout | undefined;
		let refreshing = false;
		let dashboard: WorkflowDashboard | undefined;
		let choice: WorkflowDashboardResult | null = null;
		try {
			choice = await ctx.ui.custom<WorkflowDashboardResult | null>((tui, theme, _keybindings, done) => {
				dashboard = new WorkflowDashboard(
					workflows,
					runs,
					activity,
					piSessions,
					monitorModels,
					agentEntries,
					theme,
					() => tui.requestRender(),
					done,
					currentTab,
					restore,
				);
				const refresh = async () => {
					if (refreshing || !dashboard) return;
					refreshing = true;
					try {
						const nextRuns = await listRuns(ctx);
						const [nextActivity, nextPiSessions, nextMonitorModels, nextAgentEntries] = await Promise.all([
							collectWorkflowActivity(nextRuns),
							collectPiSessions(ctx),
							deriveWorkflowMonitorModels(nextRuns),
							collectWorkflowAgents(nextRuns),
						]);
						dashboard.setRuns(nextRuns);
						dashboard.setActivity(nextActivity);
						dashboard.setPiSessions(nextPiSessions);
						dashboard.setMonitorModels(nextMonitorModels);
						dashboard.setAgentEntries(nextAgentEntries);
						dashboard.markRefreshOk();
						tui.requestRender();
					} catch (err) {
						// Never let a transient listRuns/read failure become an unhandled
						// rejection that freezes the dashboard with stale data and no signal.
						dashboard?.markRefreshError(err instanceof Error ? err.message : String(err));
						tui.requestRender();
					} finally {
						refreshing = false;
					}
				};
				refreshTimer = setInterval(() => void refresh(), 1500);
				return dashboard;
			});
		} finally {
			if (refreshTimer) clearInterval(refreshTimer);
		}
		if (!choice) return;
		const savedSelection = dashboard?.getSelection();
		const action = await handleDashboardChoice(pi, ctx, choice, options);
		if (action === "close") return;
		currentTab = savedSelection?.tab ?? currentTab;
		restore = savedSelection;
	}
}

async function handleDashboardChoice(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	choice: WorkflowDashboardResult,
	options: WorkflowDashboardOpenOptions,
): Promise<"reopen" | "close"> {
	if (choice.type === "switchSession" && choice.session) {
		await switchToPiSession(ctx, choice.session, options);
		return "close";
	}
	if (choice.type === "newPattern" && choice.pattern) {
		const workflow = await createWorkflowDraftFromPattern(ctx, choice.pattern);
		if (workflow) {
			notify(
				ctx,
				`Wrote ${workflow.path}\nRun it with /workflow start ${workflow.name} ${choice.pattern.inputHint}`,
				"info",
			);
		}
		return "close";
	}
	if (choice.type === "graph") {
		const workflow = choice.workflow ?? (choice.run ? await resolveWorkflowForRun(ctx, choice.run) : undefined);
		if (!workflow) {
			notify(ctx, "Cannot open graph: workflow file not found.", "warning");
			return "reopen";
		}
		const code = await fs.readFile(workflow.path, "utf8");
		await showWorkflowGraph(ctx, workflow, code);
		return "reopen";
	}
	if (choice.type === "agent" && choice.run && choice.agent) {
		await showLiveAgentView(ctx, choice.run, choice.agent);
		return "reopen";
	}
	if (choice.type === "view" && choice.run) {
		await showText(ctx, `Workflow run: ${choice.run.runId}`, await formatRunView(choice.run));
		return "reopen";
	}
	if (choice.type === "cancel" && choice.run) {
		const ok = await ctx.ui.confirm(
			"Cancel workflow run?",
			`Workflow: ${choice.run.workflow}\nRun: ${choice.run.runId}\n\nThis aborts the active background run. Artifacts already written remain on disk.`,
		);
		if (ok) {
			const message = await cancelWorkflowRun(ctx, choice.run.runId);
			notify(ctx, message, "warning");
		}
		return "reopen";
	}
	if (choice.type === "deleteRun" && choice.run) {
		if (canCancelRun(choice.run)) {
			notify(ctx, `Run is still active; cancel it before deleting artifacts: ${choice.run.runId}`, "warning");
			return "reopen";
		}
		const ok = await ctx.ui.confirm(
			"Delete workflow run artifacts?",
			`Workflow: ${choice.run.workflow}\nRun: ${choice.run.runId}\nState: ${getRunStatusLabel(choice.run)}\nDirectory: ${choice.run.runDir}\n\nThis permanently deletes this run directory and its artifacts. The workflow file is not deleted.`,
		);
		if (ok) {
			const message = await deleteWorkflowRun(ctx, choice.run.runId);
			notify(ctx, message, "warning");
		}
		return "reopen";
	}
	if (choice.type === "deleteWorkflow" && choice.workflow) {
		const activeForWorkflow = [...activeRuns.values()].filter(
			(run) => run.workflow.path === choice.workflow!.path || run.workflow.name === choice.workflow!.name,
		);
		const ok = await ctx.ui.confirm(
			"Delete workflow?",
			`Workflow: ${choice.workflow.name}\nScope: ${choice.workflow.scope}\nPath: ${choice.workflow.path}\n\nThis deletes only the workflow file, not previous run artifacts.${activeForWorkflow.length ? `\n\nWarning: ${activeForWorkflow.length} active run(s) from this workflow will keep running unless cancelled.` : ""}`,
		);
		if (ok) {
			await fs.unlink(choice.workflow.path);
			notify(ctx, `Deleted workflow ${choice.workflow.name}: ${choice.workflow.path}`, "info");
		}
		return "reopen";
	}
	if (choice.type === "rerun" && choice.run) {
		if (canCancelRun(choice.run)) {
			notify(ctx, `Run is still active; cancel or wait before rerunning: ${choice.run.runId}`, "warning");
			return "reopen";
		}
		const workflow = await resolveWorkflowForRun(ctx, choice.run);
		if (!workflow) {
			notify(ctx, "Cannot rerun: workflow file not found.", "warning");
			return "reopen";
		}
		const loaded = await loadRerunInput(ctx, choice.run);
		if (loaded) {
			const ok = await ctx.ui.confirm(
				"Rerun workflow?",
				`Workflow: ${workflow.name}\nFrom run: ${choice.run.runId}\nInput: ${loaded.source}\n\n${stringify(loaded.input, 1200)}`,
			);
			if (ok) await runWorkflowFromUi(pi, ctx, workflow, loaded.input);
		}
		return "reopen";
	}
	if (choice.type === "run" && choice.workflow) {
		const inputText = await ctx.ui.editor("Workflow input JSON", "{}");
		if (inputText !== undefined) {
			const input = parseCliJsonOrText(inputText, { strictJson: true });
			const ok = await ctx.ui.confirm(
				"Run workflow?",
				`Workflow: ${choice.workflow.name}\n\n${stringify(input, 1200)}`,
			);
			if (ok) await runWorkflowFromUi(pi, ctx, choice.workflow, input);
		}
		return "reopen";
	}
	return "close";
}

async function runWorkflow(
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
	let cachedCalls = 0;

	// Assign the occurrence index for a key synchronously, in emission order.
	// Same key (identical args) -> 0, 1, 2, ...; distinct args -> distinct key.
	function nextOcc(key: string): number {
		const occ = occCounters.get(key) ?? 0;
		occCounters.set(key, occ + 1);
		return occ;
	}

	function journalLookup(key: string, occ: number): SubagentResult | BashResult | undefined {
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
		await fs.appendFile(file, data);
		await appendEvent({ type: "artifact_append", path: file });
		return { path: file };
	}

	async function runSubagent(prompt: string, options: InternalAgentOptions = {}): Promise<SubagentResult> {
		throwIfAborted(runSignal.signal);
		let effectiveOptions = (await applyPersonaOptions(ctx, options)) as InternalAgentOptions;
		effectiveOptions = await applyDefaultAgentAccess(ctx, effectiveOptions);
		if (effectiveOptions.schema !== undefined) {
			effectiveOptions = appendSystemPromptOption(
				effectiveOptions,
				makeStructuredOutputSystemPrompt(effectiveOptions.schema),
			);
		}
		const phase = effectiveOptions.__workflowPhase;
		const envAccess = normalizeAgentEnvAccess(effectiveOptions);
		const accessMarkdown = formatAgentAccessMarkdown(effectiveOptions, envAccess);
		// Content-address cache. occ is assigned synchronously, in emission order,
		// before any await, so it is deterministic under ctx.agents/mapLimit
		// concurrency. agent() is cached by default; opt out with { cache: false }.
		const cacheEnabled = effectiveOptions.cache !== false;
		const key = computeCallKey("agent", [prompt, sanitizeAgentOpts(effectiveOptions)]);
		const occ = nextOcc(key);
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
					...(hit.skills?.length || !effectiveOptions.skills?.length
						? {}
						: { skills: effectiveOptions.skills }),
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
			throw new Error(`Workflow exceeded maxAgents=${runLimits.maxAgents}.`);
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
			? artifactName.slice(0, -3) + ".stdout.log"
			: `${artifactName}.stdout.log`;
		const liveStderrArtifactName = artifactName.endsWith(".md")
			? artifactName.slice(0, -3) + ".stderr.log"
			: `${artifactName}.stderr.log`;
		const liveStdoutArtifact = await writeArtifact(liveStdoutArtifactName, "");
		const liveStderrArtifact = await writeArtifact(liveStderrArtifactName, "");
		let liveWriteTail: Promise<unknown> = Promise.resolve();
		const appendLive = (file: string, chunk: Buffer) => {
			liveWriteTail = liveWriteTail.then(() => fs.appendFile(file, chunk)).catch(() => {});
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
			if (effectiveOptions.provider) args.push("--provider", effectiveOptions.provider);
			const model = effectiveOptions.model ?? (effectiveOptions.provider ? undefined : makeModelArg(ctx));
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
				await publishStatus();
				attemptWrapper = envAccess.useEnvCommand ? await createAgentEnvWrapper(envAccess) : undefined;
				envWrapper = attemptWrapper;
				const processSpec = buildAgentProcess(attemptPrompt);
				result = await runStreamingAgentProcess(processSpec.command, processSpec.args, {
					cwd: effectiveOptions.cwd ?? ctx.cwd,
					timeoutMs: effectiveOptions.timeoutMs ?? runLimits.agentTimeoutMs,
					signal: runSignal.signal,
					onStdout: (chunk) => appendLive(liveStdoutArtifact.path, chunk),
					onStderr: (chunk) => appendLive(liveStderrArtifact.path, chunk),
				});
				await liveWriteTail;
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
			throwIfAborted(runSignal.signal);
			const parsedStrictOutput = parsePiJsonModeOutput(result.stdout);
			const parsedOutput = parsedStrictOutput.ok
				? parsedStrictOutput
				: parsePiJsonModeOutputLenient(result.stdout);
			if (!parsedStrictOutput.ok) {
				await log(`agent ${id} json output ${parsedOutput.ok ? "recovered" : "fallback"}: ${name}`, {
					warning: parsedStrictOutput.warning,
					...(parsedOutput.ok ? {} : { lenientWarning: parsedOutput.warning }),
					attempt: attempt + 1,
				});
			}
			output = truncate(
				parsedOutput.ok ? parsedOutput.output : result.stdout.trim() || result.stderr.trim(),
				MAX_AGENT_OUTPUT_IN_RESULT,
			);
			if (schema === undefined) break;
			const extracted = extractJsonCandidate(output);
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
		const artifact = await writeArtifact(
			artifactName,
			`# ${name}\n\n- ok: ${result.code === 0 && !result.killed}\n- code: ${result.code}\n- elapsedMs: ${elapsedMs}${phaseLine}${schema === undefined ? "" : `\n- schemaOk: ${schemaOk === true}`}\n\n## Access\n\n${accessMarkdown}\n\n## Prompt\n\n${prompt}${schema === undefined ? "" : `\n\n## Structured Output\n\n${schemaOk === true ? `Data:\n\n${safeJson(schemaData)}` : `Error:\n\n${schemaError || "schema validation failed"}`}`}\n\n## Stdout\n\n${result.stdout}\n\n## Stderr\n\n${result.stderr}\n`,
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
			if (hit && !("artifactPath" in hit)) {
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
			throw new Error(
				`Command failed (${bashResult.code}): ${command}\n${bashResult.stderr || bashResult.stdout}`,
			);
		}
		return bashResult;
	}

	async function runSubworkflow(name: string, workflowInput: unknown = {}): Promise<unknown> {
		throwIfAborted(runSignal.signal);
		const subWorkflow = await resolveWorkflow(ctx, name, "auto");
		if (path.resolve(subWorkflow.path) === path.resolve(workflowFile.path)) {
			throw new Error(
				`ctx.workflow() refused recursive call to ${subWorkflow.name}. Sub-workflows are depth-1 and may not call their parent.`,
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
							"ctx.workflow() composition depth limit is 1: sub-workflows cannot call other sub-workflows.",
						);
					},
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
	return result;
}

function initialRunStatus(
	workflow: WorkflowFile,
	prepared: PreparedWorkflowRun,
	active: boolean,
	limits?: RunLimits,
): WorkflowRunStatus {
	const now = Date.now();
	return {
		workflow: workflow.name,
		scope: workflow.scope,
		file: workflow.path,
		runId: prepared.runId,
		runDir: prepared.runDir,
		state: "running",
		background: prepared.background,
		active,
		startedAt: new Date(prepared.started).toISOString(),
		updatedAt: new Date(now).toISOString(),
		elapsedMs: now - prepared.started,
		agentCount: 0,
		...(limits
			? {
					agentConcurrency: limits.concurrency,
					maxAgents: limits.maxAgents,
					parallelAgents: 0,
					peakParallelAgents: prepared.resume?.previousPeakParallelAgents ?? 0,
				}
			: {}),
		logs: [],
	};
}

function formatBackgroundStart(status: WorkflowRunStatus): string {
	return [
		`Started background workflow: ${status.workflow}`,
		`Run: ${status.runId}`,
		`Parallel agents: ${formatParallelAgents(status)}`,
		`Status: ${path.join(status.runDir, "status.json")}`,
		`Artifacts: ${status.runDir}`,
		`View: dynamic_workflow action=view name=${status.runId}`,
		`Cancel: dynamic_workflow action=cancel name=${status.runId}`,
	].join("\n");
}

function makeWorkflowWakePrompt(result: WorkflowRunResult): string {
	const state = getRunStatusLabel(result);
	return `Background workflow finished.

Workflow: ${result.workflow}
Run: ${result.runId}
State: ${state}
Artifacts: ${result.runDir}

Please inspect the run with dynamic_workflow action=view name=${result.runId}, read relevant artifacts if needed, and continue the user's task. If the workflow failed, went stale, or produced risks, explain that clearly and propose the next action.`;
}

function wakeAgentForWorkflowResult(pi: ExtensionAPI, ctx: ExtensionContext, result: WorkflowRunResult): void {
	if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
	if (getRunState(result) === "cancelled") return;
	const prompt = makeWorkflowWakePrompt(result);
	if (ctx.isIdle()) pi.sendUserMessage(prompt);
	else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

function canLaunchWorkflowInBackground(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui" || ctx.mode === "rpc";
}

function shouldLaunchWorkflowInBackground(ctx: ExtensionContext): boolean {
	// Project preference: every workflow launched from a persistent session runs
	// in background so the dashboard remains the control plane and completion can
	// wake the agent. Print/json modes have no live session to keep the run alive.
	return canLaunchWorkflowInBackground(ctx);
}

async function startWorkflowBackground(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	workflow: WorkflowFile,
	input: unknown,
	limits: RunLimits,
	preparedRun?: PreparedWorkflowRun,
): Promise<WorkflowRunStatus> {
	if (!canLaunchWorkflowInBackground(ctx)) {
		throw new Error(
			"Background workflow runs require a persistent TUI/RPC session. In print/json mode, action=run falls back to foreground because there is no live session to keep a background run alive.",
		);
	}
	// For resume, preparedRun reuses the existing runDir/runId in place.
	const prepared = preparedRun ?? (await prepareWorkflowRun(ctx, workflow.name, true));
	const controller = new AbortController();
	const active: ActiveWorkflowRun = {
		runId: prepared.runId,
		runDir: prepared.runDir,
		started: prepared.started,
		workflow,
		controller,
	};
	activeRuns.set(prepared.runId, active);
	const status = initialRunStatus(workflow, prepared, true, limits);
	await writeRunStatus(status);
	refreshActiveWorkflowStatus(ctx);

	const promise = runWorkflow(pi, ctx, workflow, input, limits, controller.signal, undefined, prepared)
		.then((result) => {
			const resultState = getRunState(result);
			const type = resultState === "completed" ? "info" : resultState === "cancelled" ? "warning" : "error";
			notify(
				ctx,
				`Background workflow ${getRunStatusLabel(result)}: ${workflow.name}\nRun: ${result.runId}\nArtifacts: ${result.runDir}`,
				type,
			);
			wakeAgentForWorkflowResult(pi, ctx, result);
			return result;
		})
		.catch(async (err) => {
			const now = Date.now();
			const error = err instanceof Error ? err.stack || err.message : String(err);
			const result: WorkflowRunResult = {
				workflow: workflow.name,
				scope: workflow.scope,
				file: workflow.path,
				runId: prepared.runId,
				runDir: prepared.runDir,
				ok: false,
				state: "failed",
				background: true,
				startedAt: new Date(prepared.started).toISOString(),
				endedAt: new Date(now).toISOString(),
				elapsedMs: now - prepared.started,
				agentCount: 0,
				agentConcurrency: limits.concurrency,
				maxAgents: limits.maxAgents,
				parallelAgents: 0,
				peakParallelAgents: 0,
				logs: [],
				error,
			};
			await writeJsonFile(path.join(prepared.runDir, "result.json"), result);
			await writeRunStatus({
				...initialRunStatus(workflow, prepared, false, limits),
				state: "failed",
				endedAt: new Date(now).toISOString(),
				updatedAt: new Date(now).toISOString(),
				elapsedMs: now - prepared.started,
				error,
			});
			await fs.writeFile(path.join(prepared.runDir, "summary.md"), formatRunSummary(result), "utf8");
			notify(
				ctx,
				`Background workflow failed to run: ${workflow.name}\nRun: ${prepared.runId}\nError: ${error}`,
				"error",
			);
			wakeAgentForWorkflowResult(pi, ctx, result);
			return result;
		})
		.finally(() => {
			activeRuns.delete(prepared.runId);
			refreshActiveWorkflowStatus(ctx);
		});
	active.promise = promise;
	void promise;
	return status;
}

// Resume an interrupted run in place (same runDir/runId), reusing the journal so
// already-completed subagent/bash calls are not re-executed.
async function resumeWorkflow(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	idOrLatest: string | undefined,
	opts: { background?: boolean; force?: boolean } = {},
	signal?: AbortSignal,
	onProgress?: (logs: WorkflowLogEntry[], status?: WorkflowRunStatus) => void,
): Promise<WorkflowRunRecord> {
	const record = await resolveRun(ctx, idOrLatest);
	if (activeRuns.has(record.runId)) {
		throw new Error(`Workflow run is already active: ${record.runId}. Cancel it first or wait for it to finish.`);
	}
	const state = getRunState(record);
	const resumable =
		state === "stale" ||
		state === "failed" ||
		state === "cancelled" ||
		(opts.force === true && state === "completed");
	if (!resumable) {
		if (state === "running")
			throw new Error(`Workflow run ${record.runId} is still running. Cancel it before resuming.`);
		if (state === "completed")
			throw new Error(`Workflow run ${record.runId} already completed. Use force:true to resume it anyway.`);
		throw new Error(`Workflow run ${record.runId} cannot be resumed (state: ${String(state)}).`);
	}

	const workflow = await resolveWorkflow(ctx, record.workflow, record.scope);
	const code = await fs.readFile(workflow.path, "utf8");
	const codeHash = computeCodeHash(code);
	const journal = await loadJournal(record.runDir);
	// Start agentCount above the highest id already used (journaled OR on disk),
	// so freshly re-run subagents can never overwrite an existing agents/NNNN
	// artifact, even when the journal is non-contiguous or has {cache:false} gaps.
	const baseAgentCount = Math.max(maxJournalAgentId(journal), await maxAgentArtifactNumber(record.runDir));

	let input: unknown = {};
	try {
		input = JSON.parse(await fs.readFile(path.join(record.runDir, "input.json"), "utf8"));
	} catch {
		input = {};
	}
	const limits = buildLimits(limitParamsFromInput(input));
	const resumeInBackground = shouldLaunchWorkflowInBackground(ctx);

	const prepared: PreparedWorkflowRun = {
		started: Number.isFinite(new Date(record.startedAt).getTime())
			? new Date(record.startedAt).getTime()
			: Date.now(),
		runId: record.runId,
		runDir: record.runDir,
		background: resumeInBackground,
		resume: {
			journal,
			baseAgentCount,
			codeHash,
			resumedFrom: record.runId,
			previousPeakParallelAgents: getRunPeakParallelAgents(record) ?? 0,
		},
	};
	await ensureDir(path.join(record.runDir, "agents"));
	// Remove the stale result.json from the prior (failed/cancelled/completed)
	// run. readRunRecord reads result.json before status.json, so leaving it in
	// place would mask the live running status for the duration of the resume
	// (runs/view/dashboard would show the old terminal state). runWorkflow
	// rewrites result.json when the resumed run finishes.
	await fs.rm(path.join(record.runDir, "result.json"), { force: true }).catch(() => {});

	const previousHash = record.codeHash;
	if (previousHash && previousHash !== codeHash) {
		notify(
			ctx,
			`Note: workflow code changed since run ${record.runId} (codeHash ${previousHash.slice(0, 12)} -> ${codeHash.slice(0, 12)}). Calls whose arguments changed will be re-executed (cache miss); unchanged calls stay cached.`,
			"warning",
		);
	}

	if (resumeInBackground) {
		// Returns a WorkflowRunStatus (the run keeps executing in the background).
		return await startWorkflowBackground(pi, ctx, workflow, input, limits, prepared);
	}

	// Print/json fallback: returns a WorkflowRunResult because background cannot stay alive.
	return await runWorkflowWithUi(pi, ctx, workflow, input, limits, signal, onProgress, prepared);
}

function resolveActiveRun(id: string | undefined): ActiveWorkflowRun | undefined {
	const runs = [...activeRuns.values()].sort((a, b) => b.started - a.started);
	const key = id?.trim();
	if (!key || key === "latest") return runs[0];
	return (
		activeRuns.get(key) ??
		selectRunByKey(
			runs,
			key,
			(run) => run.runId,
			(run) => run.workflow.name,
		)
	);
}

async function cancelWorkflowRun(ctx: ExtensionContext, id: string | undefined): Promise<string> {
	const active = resolveActiveRun(id);
	if (!active) {
		if (id?.trim()) {
			try {
				const run = await resolveRun(ctx, id);
				return `Workflow run is not active (${getRunStatusLabel(run)}): ${run.runId}`;
			} catch {
				// Fall through to a clearer active-run message.
			}
		}
		throw new Error("No active background workflow run found.");
	}
	active.controller.abort("Workflow cancelled.");
	const existing = await readRunStatus(active.runDir);
	if (existing) {
		const now = Date.now();
		await writeRunStatus({
			...existing,
			state: "cancelled",
			active: false,
			updatedAt: new Date(now).toISOString(),
			endedAt: new Date(now).toISOString(),
			elapsedMs: now - active.started,
			error: "Workflow cancelled.",
		});
	}
	return `Cancellation requested for background workflow run: ${active.runId}`;
}

async function resolveRunForDeletion(
	ctx: ExtensionContext,
	id: string | undefined,
): Promise<{ run: WorkflowRunRecord; runDir: string }> {
	const dirs = await getRunDirs(ctx);
	const records: { run: WorkflowRunRecord; runDir: string }[] = [];
	for (const runDir of dirs) {
		const run = await readRunRecord(runDir);
		if (run) records.push({ run, runDir });
	}
	if (records.length === 0) throw new Error("No workflow runs found.");
	const key = id?.trim() || "latest";
	if (key === "latest") return records[0];
	const found = selectRunByKey(
		records,
		key,
		({ run }) => run.runId,
		({ run }) => run.workflow,
	);
	if (!found) throw new Error(`Workflow run not found: ${key}`);
	return found;
}

async function deleteWorkflowRun(ctx: ExtensionContext, id: string | undefined): Promise<string> {
	const { run, runDir } = await resolveRunForDeletion(ctx, id);
	if (activeRuns.has(run.runId))
		throw new Error(`Workflow run is active; cancel it before deleting artifacts: ${run.runId}`);
	await fs.rm(runDir, { recursive: true, force: false });
	return `Deleted workflow run artifacts: ${run.runId}\nDirectory: ${runDir}`;
}

// Race a promise against a timeout. The timeout timer is always cleared afterwards so a
// fast-settling promise can't leave a pending timer keeping the event loop alive (e.g. at
// session shutdown).
export async function settleWithinTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const guard = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, timeoutMs);
	});
	try {
		await Promise.race([work.then(() => undefined), guard]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function abortActiveWorkflowRuns(reason: string): Promise<void> {
	const promises = [...activeRuns.values()]
		.map((run) => {
			run.controller.abort(reason);
			return run.promise;
		})
		.filter((promise): promise is Promise<WorkflowRunResult> => promise !== undefined);
	if (promises.length === 0) return;
	await settleWithinTimeout(Promise.allSettled(promises), 3000);
	activeRuns.clear();
}

async function handleTool(
	pi: ExtensionAPI,
	params: DynamicWorkflowToolParams,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback | undefined,
	ctx: ExtensionContext,
) {
	const action = params.action;
	const scope = params.scope ?? "auto";

	if (action === "template") {
		const pattern = params.name ? resolveWorkflowPattern(params.name) : undefined;
		if (params.name && !pattern) {
			throw new Error(
				`Unknown workflow pattern: ${params.name}. Available: ${WORKFLOW_PATTERN_CATALOG.map((item) => item.key).join(", ")}`,
			);
		}
		if (pattern) {
			const template = await loadWorkflowPatternCode(pattern);
			return { content: [text(template)], details: { action, pattern, template } };
		}
		return {
			content: [text(formatWorkflowPatternCatalog())],
			details: { action, patterns: WORKFLOW_PATTERN_CATALOG, template: WORKFLOW_TEMPLATE },
		};
	}

	if (action === "list") {
		const workflows = await listWorkflows(ctx);
		return { content: [text(formatWorkflowList(workflows))], details: { action, workflows } };
	}

	if (action === "runs") {
		const runs = await listRuns(ctx);
		return { content: [text(formatRunList(runs))], details: { action, runs } };
	}

	if (action === "view") {
		const run = await resolveRun(ctx, params.name);
		const view = await formatRunView(run);
		return { content: [text(view)], details: { action, run } };
	}

	if (action === "cancel") {
		const message = await cancelWorkflowRun(ctx, params.name);
		return { content: [text(message)], details: { action, message } };
	}

	if (action === "resume") {
		const resumeInBackground = shouldLaunchWorkflowInBackground(ctx);
		const record = await resumeWorkflow(
			pi,
			ctx,
			params.name,
			{ background: resumeInBackground, force: !!params.force },
			signal,
			(logs) => {
				const preview = logs
					.slice(-8)
					.map((entry) => `${entry.time.slice(11, 19)} ${entry.message}`)
					.join("\n");
				onUpdate?.({ content: [text(preview)], details: { action, logCount: logs.length } });
			},
		);
		if (resumeInBackground) {
			const status = record as WorkflowRunStatus;
			return { content: [text(formatBackgroundStart(status))], details: { action, status } };
		}
		const result = record as WorkflowRunResult;
		if (!result.ok) throw new Error(formatRunSummary(result));
		return { content: [text(formatRunSummary(result))], details: { action, result } };
	}

	if (!params.name) throw new Error(`dynamic_workflow action=${action} requires name.`);

	if (action === "read") {
		const workflow = await resolveWorkflow(ctx, params.name, scope);
		const code = await fs.readFile(workflow.path, "utf8");
		return { content: [text(code)], details: { action, workflow, code } };
	}

	if (action === "graph") {
		const workflow = await resolveWorkflow(ctx, params.name, scope);
		const code = await fs.readFile(workflow.path, "utf8");
		const graph = await makeWorkflowGraphForContext(ctx, workflow, code);
		return { content: [text(graph)], details: { action, workflow, graph } };
	}

	if (action === "write") {
		if (params.code === undefined) throw new Error("dynamic_workflow action=write requires code.");
		const workflow = await resolveWorkflow(ctx, params.name, scope, "draft");
		await ensureDir(path.dirname(workflow.path));
		await fs.writeFile(workflow.path, params.code, "utf8");
		return {
			content: [text(`Wrote workflow ${workflow.name} (${workflow.scope}) to ${workflow.path}`)],
			details: { action, workflow },
		};
	}

	if (action === "delete") {
		const workflow = await resolveWorkflow(ctx, params.name, scope);
		if (!ctx.hasUI) throw new Error("Deleting workflows requires interactive confirmation.");
		const ok = await ctx.ui.confirm("Delete workflow?", `${workflow.name}\n${workflow.path}`);
		if (!ok) throw new Error("Workflow deletion cancelled.");
		await fs.unlink(workflow.path);
		return {
			content: [text(`Deleted workflow ${workflow.name} (${workflow.scope}) from ${workflow.path}`)],
			details: { action, workflow },
		};
	}

	if (action === "start" || (action === "run" && shouldLaunchWorkflowInBackground(ctx))) {
		const workflow = await resolveWorkflow(ctx, params.name, scope);
		const workflowInput = normalizeWorkflowInput(params.input);
		const limits = buildLimits({ ...limitParamsFromInput(workflowInput), ...params });
		const status = await startWorkflowBackground(pi, ctx, workflow, workflowInput, limits);
		return {
			content: [text(formatBackgroundStart(status))],
			details: { action, workflow, status },
		};
	}

	if (action === "run") {
		const workflow = await resolveWorkflow(ctx, params.name, scope);
		const workflowInput = normalizeWorkflowInput(params.input);
		const limits = buildLimits({ ...limitParamsFromInput(workflowInput), ...params });
		const result = await runWorkflowWithUi(pi, ctx, workflow, workflowInput, limits, signal, (logs) => {
			const preview = logs
				.slice(-8)
				.map((entry) => `${entry.time.slice(11, 19)} ${entry.message}`)
				.join("\n");
			onUpdate?.({
				content: [text(preview)],
				details: { action, workflow, logCount: logs.length },
			});
		});
		if (!result.ok) throw new Error(formatRunSummary(result));
		return { content: [text(formatRunSummary(result))], details: { action, workflow, result } };
	}

	throw new Error(`Unknown dynamic_workflow action: ${String(action)}`);
}

async function handleWorkflowCommand(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
	const trimmed = args.trim();
	const actionMatch = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	const action = (actionMatch?.[1] || "list").toLowerCase();
	const afterAction = actionMatch?.[2]?.trimStart() ?? "";
	const nameMatch = /^(\S+)(?:\s+([\s\S]*))?$/.exec(afterAction);
	const commandName = nameMatch?.[1];
	const trailingText = nameMatch?.[2] ?? "";

	try {
		if (action === "list" || action === "ls") {
			notify(ctx, formatWorkflowList(await listWorkflows(ctx)), "info");
			return;
		}

		if (action === "dashboard" || action === "tui") {
			await openWorkflowDashboard(pi, ctx);
			return;
		}

		if (action === "agents" || action === "agent") {
			await openWorkflowDashboard(pi, ctx, "agents");
			return;
		}

		if (action === "sessions" || action === "session") {
			if (ctx.mode === "tui") await openWorkflowDashboard(pi, ctx, "sessions");
			else await showText(ctx, "Pi sessions", formatPiSessionList(await collectPiSessions(ctx)));
			return;
		}

		if (action === "switch-session") {
			const sessionFile = parseWorkflowCommandArgument(afterAction);
			if (!sessionFile) {
				notify(ctx, "Usage: /workflow switch-session <session-file>", "warning");
				return;
			}
			const resolvedSessionFile = path.isAbsolute(sessionFile) ? sessionFile : path.resolve(ctx.cwd, sessionFile);
			const sessions = await collectPiSessions(ctx);
			const session = sessions.find(
				(item) => item.sessionFile && path.resolve(item.sessionFile) === resolvedSessionFile,
			) ?? {
				id: `manual:${resolvedSessionFile}`,
				pid: 0,
				mode: "session",
				cwd: ctx.cwd,
				startedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				file: resolvedSessionFile,
				live: false,
				current: false,
				ageMs: Number.POSITIVE_INFINITY,
				sessionFile: resolvedSessionFile,
				sessionName: path.basename(resolvedSessionFile),
				staleReason: "not in live registry",
			};
			await switchToPiSession(ctx, session);
			return;
		}

		if (action === "patterns" || action === "catalog" || action === "templates") {
			if (ctx.mode === "tui") await openWorkflowDashboard(pi, ctx, "patterns");
			else await showText(ctx, "Workflow pattern catalog", formatWorkflowPatternCatalog());
			return;
		}

		if (action === "graph" || action === "viz") {
			const name = commandName;
			if (!name) {
				notify(ctx, "Usage: /workflow graph <name>", "warning");
				return;
			}
			const workflow = await resolveWorkflow(ctx, name, "auto");
			const code = await fs.readFile(workflow.path, "utf8");
			await showWorkflowGraph(ctx, workflow, code);
			return;
		}

		if (action === "runs") {
			await showText(ctx, "Workflow runs", formatRunList(await listRuns(ctx)));
			return;
		}

		if (action === "view") {
			const run = await resolveRun(ctx, commandName);
			await showText(ctx, `Workflow run: ${run.runId}`, await formatRunView(run));
			return;
		}

		if (action === "new" || action === "create") {
			const name = commandName;
			if (!name) {
				notify(ctx, "Usage: /workflow new <name> [--pattern=<key>]", "warning");
				return;
			}
			if (!ctx.hasUI) {
				notify(
					ctx,
					"/workflow new requires interactive UI. Use dynamic_workflow action=write in agent mode.",
					"warning",
				);
				return;
			}
			const patternKey = parsePatternFlag(trailingText);
			const pattern = patternKey ? resolveWorkflowPattern(patternKey) : undefined;
			if (patternKey && !pattern) {
				notify(
					ctx,
					`Unknown workflow pattern: ${patternKey}. Available: ${WORKFLOW_PATTERN_CATALOG.map((item) => item.key).join(", ")}`,
					"warning",
				);
				return;
			}
			const template = pattern ? await loadWorkflowPatternCode(pattern) : WORKFLOW_TEMPLATE;
			const edited = await ctx.ui.editor(
				pattern ? `New workflow: ${name} (${pattern.key})` : `New workflow: ${name}`,
				template,
			);
			if (edited === undefined) return;
			const workflow = await resolveWorkflow(ctx, name, "project", "workflow");
			if (existsSync(workflow.path)) {
				const ok = await ctx.ui.confirm("Overwrite existing workflow?", `${workflow.name}\n${workflow.path}`);
				if (!ok) return;
			}
			await ensureDir(path.dirname(workflow.path));
			await fs.writeFile(workflow.path, edited, "utf8");
			notify(ctx, `Wrote ${workflow.path}${pattern ? ` from pattern ${pattern.key}` : ""}`, "info");
			return;
		}

		if (action === "show" || action === "edit" || action === "open") {
			const name = commandName;
			if (!name) {
				notify(ctx, "Usage: /workflow edit <name>", "warning");
				return;
			}
			if (!ctx.hasUI) {
				const workflow = await resolveWorkflow(ctx, name, "auto");
				const code = await fs.readFile(workflow.path, "utf8");
				notify(ctx, code, "info");
				return;
			}
			const workflow = await resolveWorkflow(ctx, name, "auto");
			const code = await fs.readFile(workflow.path, "utf8");
			const edited = await ctx.ui.editor(`${workflow.name} (${workflow.scope})`, code);
			if (edited !== undefined && edited !== code) {
				await fs.writeFile(workflow.path, edited, "utf8");
				notify(ctx, `Saved ${workflow.path}`, "info");
			}
			return;
		}

		if (action === "run") {
			const name = commandName;
			if (!name) {
				notify(ctx, "Usage: /workflow run <name> [json-input]", "warning");
				return;
			}
			const jsonText = trailingText.trim();
			const input = parseCliJsonOrText(jsonText);
			const workflow = await resolveWorkflow(ctx, name, "auto");
			const limits = buildLimits(limitParamsFromInput(input));
			if (shouldLaunchWorkflowInBackground(ctx)) {
				const status = await startWorkflowBackground(pi, ctx, workflow, input, limits);
				notify(ctx, formatBackgroundStart(status), "info");
				return;
			}
			let lastLogs: WorkflowLogEntry[] = [];
			const result = await runWorkflowWithUi(pi, ctx, workflow, input, limits, undefined, (logs) => {
				lastLogs = logs;
			});
			notify(ctx, formatRunSummary(result), result.ok ? "info" : "error");
			if (lastLogs.length === 0) notify(ctx, "Workflow produced no logs.", "warning");
			return;
		}

		if (action === "start" || action === "bg" || action === "background") {
			const name = commandName;
			if (!name) {
				notify(ctx, "Usage: /workflow start <name> [json-input]", "warning");
				return;
			}
			const jsonText = trailingText.trim();
			const input = parseCliJsonOrText(jsonText);
			const workflow = await resolveWorkflow(ctx, name, "auto");
			const limits = buildLimits(limitParamsFromInput(input));
			const status = await startWorkflowBackground(pi, ctx, workflow, input, limits);
			notify(ctx, formatBackgroundStart(status), "info");
			return;
		}

		if (action === "resume") {
			// Tokens after "resume": optional <runId> (defaults to latest) plus
			// --force. Persistent sessions resume in background by default; print/json
			// falls back to foreground because no background run can stay alive.
			const tokens = afterAction.split(/\s+/).filter(Boolean);
			const background = shouldLaunchWorkflowInBackground(ctx);
			const force = tokens.some((t) => t === "--force" || t === "-f");
			const runId = tokens.find((t) => !t.startsWith("-"));
			const record = await resumeWorkflow(pi, ctx, runId, { background, force });
			if (background) {
				notify(ctx, formatBackgroundStart(record as WorkflowRunStatus), "info");
			} else {
				const result = record as WorkflowRunResult;
				notify(ctx, formatRunSummary(result), result.ok ? "info" : "error");
			}
			return;
		}

		if (action === "cancel" || action === "stop") {
			const message = await cancelWorkflowRun(ctx, commandName);
			notify(ctx, message, "warning");
			return;
		}

		if (action === "delete-run" || action === "rm-run" || action === "delete-run-artifacts") {
			const run = await resolveRun(ctx, commandName);
			if (canCancelRun(run)) {
				notify(ctx, `Run is still active; cancel it before deleting artifacts: ${run.runId}`, "warning");
				return;
			}
			if (!ctx.hasUI) {
				notify(
					ctx,
					"/workflow delete-run requires interactive confirmation; refusing in no-UI mode.",
					"warning",
				);
				return;
			}
			const ok = await ctx.ui.confirm(
				"Delete workflow run artifacts?",
				`Workflow: ${run.workflow}\nRun: ${run.runId}\nState: ${getRunStatusLabel(run)}\nDirectory: ${run.runDir}\n\nThis permanently deletes this run directory and its artifacts. The workflow file is not deleted.`,
			);
			if (!ok) return;
			const message = await deleteWorkflowRun(ctx, run.runId);
			notify(ctx, message, "warning");
			return;
		}

		if (action === "delete" || action === "rm") {
			const name = commandName;
			if (!name) {
				notify(ctx, "Usage: /workflow delete <name>", "warning");
				return;
			}
			const workflow = await resolveWorkflow(ctx, name, "auto");
			if (!ctx.hasUI) {
				notify(ctx, "/workflow delete requires interactive confirmation; refusing in no-UI mode.", "warning");
				return;
			}
			const ok = await ctx.ui.confirm("Delete workflow?", `${workflow.name}\n${workflow.path}`);
			if (!ok) return;
			await fs.unlink(workflow.path);
			notify(ctx, `Deleted ${workflow.path}`, "info");
			return;
		}

		notify(
			ctx,
			"Usage: /workflow list | dashboard | agents | sessions | patterns | graph <name> | runs | view [latest|runId] | new <name> [--pattern=<key>] | edit <name> | run <name> [json] | start <name> [json] | resume [latest|runId] [--force] | cancel [latest|runId] | delete-run [latest|runId] | delete <name>",
			"warning",
		);
	} catch (err) {
		clearWorkflowWidget(ctx);
		notify(ctx, err instanceof Error ? err.message : String(err), "error");
	}
}

async function handleWorkflowsCommand(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
	if (args.trim()) {
		await handleWorkflowCommand(pi, args, ctx);
		return;
	}
	await openWorkflowDashboard(pi, ctx);
}

function formatUltracodeContractGatePrompt(taskLabel = "Ultracode tasks"): string {
	return `Contract Gate

- For substantive ${taskLabel} that survive the trivial gate, run a small read-only task-contract review workflow before normal scout/orchestration.
- If ambiguity blocks even the task contract, ask only blocking questions; otherwise let the workflow infer safe assumptions and non-goals.
- Keep it cheap and inspectable: 3-4 independent contract reviewers plus synthesis, explicit concurrency/maxAgents, artifacts under the run directory, and no file edits.
- Required synthesis fields: improvedTask, successCriteria, assumptions, nonGoals, routingHints, verificationPlan, blockers.
- Use the improved task for the routing/scouting decision and mention whether the Contract Gate ran, was skipped as trivial, or was blocked.`;
}

function formatUltracodeRoutingRules(style: "command" | "always-on"): string {
	const trivialGate =
		style === "command"
			? "solve conversational, single-step, or few-tool-call tasks directly; do not build a workflow"
			: "conversational, single-step, or few-tool-call tasks stay single-agent";
	const scoutGate =
		style === "command"
			? "if the task may be broad, probe cheaply inline to discover the real work-list"
			: "broad-looking tasks get a cheap inline probe first (git ls-files, diff, rg/glob)";
	const orchestrateGate =
		style === "command"
			? "use a workflow only for exhaustiveness, confidence, or scale"
			: "use dynamic_workflow only for exhaustiveness, confidence, or scale";
	const catalogLine =
		style === "command"
			? "Inspect the template catalog before writing code.\n- Reuse an existing workflow only on an exact task match; otherwise write a gitignored .pi/workflows/drafts/<slug>.js draft."
			: "Inspect the catalog, then reuse an exact existing fit or write a gitignored .pi/workflows/drafts/<slug>.js draft.";
	const launchLine =
		style === "command"
			? "Graph/start background runs with explicit concurrency/maxAgents, then inspect artifacts."
			: "Graph/start in background with explicit concurrency/maxAgents, then inspect artifacts.";
	const scaleLine =
		style === "command"
			? "Scale concurrency/maxAgents to the discovered work-list and risk; log caps, clamps, skipped work, and failures."
			: "Scale parallelism to the work-list and risk; log caps, clamps, skipped work, and failed branches.";
	const commandWorkflowPath = `- ${catalogLine}
- ${launchLine}
- Use workflow-factory only when a warranted workflow needs complex prompt/contract design.
- ${scaleLine}
- For audits/research, keep subagents read-only and synthesize only evidence-backed findings.`;
	const alwaysOnWorkflowPath = `- ${catalogLine}
- ${launchLine}
- ${scaleLine}
- Use workflow-factory only when a warranted workflow needs complex prompt/contract design.`;
	return `Decision gates:
- Ambiguity: if it blocks routing or implementation, infer concise success criteria when safe; ask only blocking questions.
- Trivial: ${trivialGate}.
- Scout: ${scoutGate}.
- Orchestrate: ${orchestrateGate}.

Workflow path:
${style === "command" ? commandWorkflowPath : alwaysOnWorkflowPath}
- When drafting workflow code, remember subagents get web_search via pi-codex-web-search and context7-cli when installed; do not opt out unless the task requires isolation.

Reference:
- ${formatWorkflowPatternKeyList()}
- ${formatWorkflowCompositionPromptSummary()}`;
}

function makeUltracodePrompt(
	task: string,
	mode: "ultracode" | "deep-research" = "ultracode",
	contractGateEnabled = true,
): string {
	const trimmed = task.trim();
	const header =
		mode === "deep-research"
			? "Use Pi Dynamic Workflows for a source-backed deep-research investigation."
			: "Use Pi Dynamic Workflows when they are warranted for this task.";
	const contractGate = contractGateEnabled
		? `\n\n${formatUltracodeContractGatePrompt(mode === "deep-research" ? "deep-research tasks" : "Ultracode tasks")}`
		: "";
	return `${header}

Task:
${trimmed}${contractGate}

Ultracode rules:

${formatUltracodeRoutingRules("command")}`;
}

function makeAlwaysOnUltracodeSystemPrompt(contractGateEnabled = true): string {
	const contractGate = contractGateEnabled ? `\n\n${formatUltracodeContractGatePrompt("tasks")}` : "";
	return `## Always-on Ultracode Router

For substantive tasks, choose the lightest path that can verify the answer.${contractGate}

${formatUltracodeRoutingRules("always-on")}

Mention routing only when it affects plan, cost, latency, or user expectations.`;
}

function dynamicWorkflowToolAvailable(selectedTools: string[] | undefined): boolean {
	return selectedTools?.includes("dynamic_workflow") ?? false;
}

function ensureDynamicWorkflowToolActive(pi: ExtensionAPI): boolean {
	try {
		const active = pi.getActiveTools?.();
		if (!Array.isArray(active)) return false;
		if (active.includes("dynamic_workflow")) return true;
		const exists = pi.getAllTools?.().some((tool) => tool.name === "dynamic_workflow") ?? false;
		if (!exists) return false;
		pi.setActiveTools([...new Set([...active, "dynamic_workflow"])]);
		return true;
	} catch {
		return false;
	}
}

function setUltracodeStatus(ctx: ExtensionContext, enabled: boolean): void {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	ctx.ui.setStatus(ULTRACODE_STATUS_KEY, enabled ? theme.fg("accent", "uc:auto") : theme.fg("dim", "uc:off"));
}

function clearUltracodeStatus(ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.setStatus(ULTRACODE_STATUS_KEY, undefined);
}

function setUltracodeContractGateStatus(ctx: ExtensionContext, enabled: boolean): void {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	ctx.ui.setStatus(ULTRACODE_CONTRACT_STATUS_KEY, enabled ? theme.fg("dim", "cg:on") : theme.fg("warning", "cg:off"));
}

function clearUltracodeContractGateStatus(ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.setStatus(ULTRACODE_CONTRACT_STATUS_KEY, undefined);
}

export function extractUltracodeTask(textValue: string): string | undefined {
	const trimmed = textValue.trim();
	// Separator after the keyword may be a `:`/`-` (with or without a trailing space) or just
	// whitespace, so `ultracode:do X`, `ultracode: do X`, and `ultracode do X` all parse.
	const match = /^(?:ultracode|dynamic\s+workflow)(?:\s*[:-]\s*|\s+)([\s\S]+)/i.exec(trimmed);
	return match?.[1]?.trim();
}

function isGeneratedUltracodePrompt(prompt: string): boolean {
	return prompt.includes("\nUltracode rules:\n");
}

type ToggleCommandValue = "status" | "on" | "off" | "invalid";

function parseToggleCommandValue(raw: string): ToggleCommandValue {
	const value = raw.trim().toLowerCase();
	if (!value || value === "status") return "status";
	if (["on", "enable", "enabled", "true", "1"].includes(value)) return "on";
	if (["off", "disable", "disabled", "false", "0"].includes(value)) return "off";
	return "invalid";
}

function sendWorkflowPrompt(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string): void {
	if (ctx.isIdle()) pi.sendUserMessage(prompt);
	else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
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
			"Scale parallelism to the discovered work-list and constraints. Raise concurrency/maxAgents above low defaults for many independent, read-only, low-risk branches when ctx.limits and provider budget/rate limits allow; keep them low for side effects, expensive models, shared-state edits, sequential dependencies, or uncertain rate limits. Log requested/effective concurrency, maxAgents, and any ctx.limits clamp.",
			formatWorkflowPatternKeyList(),
			formatWorkflowCompositionPromptSummary(),
			"Choose primitives by data dependency. Use ctx.agents(items,{concurrency}) for one independent step per item. Use ctx.pipeline(items,...stages) by default for >=2 dependent steps per item with no cross-item merge; include a stable item id/index in prompts generated inside stages. Use ctx.agents(items,{concurrency,settle:true}) for large fan-out or reviewer panels where one branch failure should return null. Use ctx.parallel([async()=>...]) only for a true barrier where a later step needs all branch results at once (dedup/merge, early-exit if total=0, cross-branch ranking). Use ctx.workflow(name,input) for reusable sub-steps with no decision gate; sequence separate runs when a decision depends on prior output.",
			"Use ctx.agent(prompt,{schema}) when a subagent must return JSON; consume result.data/result.schemaOk and use schemaOnInvalid:'null' when invalid JSON should become a non-throwing branch result. Use agentType:'explore'|'reviewer'|'planner'|'implementer'|'researcher' for persona defaults; explicit options override the persona. Scope each subagent's access with tools/excludeTools, skills/includeSkills, extensions/includeExtensions, and keys/env when it needs specific capabilities; never put secret values in prompts. When writing workflow code, assume subagents get web_search via pi-codex-web-search and context7-cli when installed; include web_search in read-only allowlists when web/docs/current evidence may help, and only use includeExtensions:false/includeSkills:false as an explicit opt-out.",
			"Decide model and reasoning per call: pass model (e.g. 'haiku' or 'anthropic/claude-sonnet-4'), provider, and thinking (off|minimal|low|medium|high|xhigh) on ctx.agent/ctx.agents/ctx.pipeline or any per-item spec. Use a cheap/fast model + low/minimal thinking for wide scouting, classification, and extraction; use a stronger model + high/xhigh thinking for synthesis, adversarial verification, planning, and hard reasoning. Omitting them inherits the orchestrator model (ctx.model) and session thinking level; agentType personas set thinking defaults (reviewer/planner/researcher=high, explore/implementer=medium) and explicit options win. model/provider/thinking are part of the cache key, so changing them re-runs that call on resume.",
			"Handle partial failure visibly: filter nulls from settling agents/pipeline/parallel, ctx.log() how many branches failed, and make synthesis prompts mention failed, empty, cancelled, or timed-out branches instead of hiding them.",
			"Never cap coverage silently. Whenever a workflow uses slice/head/top-N/sampling/no-retry, clamps concurrency to ctx.limits.concurrency, or lowers maxAgents below the discovered work-list, ctx.log() exactly what was excluded, delayed, or clamped.",
			"When creating a workflow, inspect the pattern catalog first (optionally action=template name=<key> for a scaffold), reuse an existing workflow only when it exactly matches the task, otherwise write a clear gitignored .pi/workflows/drafts/<task-slug>.js project draft and launch it in background with explicit limits (action=start in persistent TUI/RPC; action=run only as the print/non-persistent fallback). If a workflow is warranted for complex workflow/prompt/contract design, use the workflow-factory scaffold so a workflow generates and reviews the task-specific workflow. After a useful run, tell the user the path and offer to keep/promote it to a stable workflow name.",
			"Workflows in persistent TUI/RPC sessions always run in background: use dynamic_workflow action=start (or action=run, which the extension backgrounds there), then inspect with action=runs/view and stop with action=cancel if needed.",
			"If a run was interrupted (state stale/failed/cancelled), use dynamic_workflow action=resume name=<runId> to continue it in place; completed subagent/bash calls are reused from the run journal and are not re-executed, so resuming is cheap. agent() output is cached by default (opt out with {cache:false}); bash() is cached only with {cache:true}. Calls whose arguments depend on Date.now()/Math.random() will not be cached and will re-run on resume.",
			"Workflow scripts are trusted code. Keep subagent prompts scoped, use read-only tool lists for audit/research tasks, and persist intermediate outputs with ctx.writeArtifact().",
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

	pi.registerCommand("ultracode", {
		description: "Ask Pi to solve a complex task using dynamic workflows when warranted",
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

	pi.registerCommand("dynamic-workflow", {
		description: "Alias for /ultracode: solve a complex task using dynamic workflows when warranted",
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
				notify(
					ctx,
					`Ultracode Contract Gate is ${ultracodeContractGateEnabled ? "enabled" : "disabled"}.`,
					"info",
				);
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
