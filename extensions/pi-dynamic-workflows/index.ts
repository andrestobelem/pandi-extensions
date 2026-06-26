/**
 * Claude-style Dynamic Workflows for Pi.
 *
 * This extension adds:
 * - `dynamic_workflow` tool for the model to list/read/write/run workflow scripts
 * - `/workflow` and `/workflows` commands for humans
 * - a small JavaScript workflow runtime with parallel Pi subagents and artifacts
 *
 * Workflows are trusted code. They run inside the Pi process (not a security
 * sandbox) and can spend model calls by spawning subagents.
 */

import {
	CONFIG_DIR_NAME,
	CustomEditor,
	getAgentDir,
	type AgentToolUpdateCallback,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Image as TerminalImage, Key, getCapabilities, matchesKey, truncateToWidth, visibleWidth, type EditorComponent } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
	WORKFLOW_PATTERN_CATALOG,
	WORKFLOW_TEMPLATE,
	formatWorkflowCompositionPromptGuidance,
	formatWorkflowCompositionPromptSummary,
	formatWorkflowPatternCatalog,
	formatWorkflowPatternKeyList,
	formatWorkflowPatternPromptCheatSheet,
	getPatternAliases,
	getPatternUseCases,
	loadWorkflowPatternCode,
	resolveWorkflowPattern,
	type WorkflowPattern,
} from "./templates.js";

const WORKFLOW_DIR = "workflows";
const WORKFLOW_DRAFT_DIR = path.join(WORKFLOW_DIR, "drafts");
const WORKFLOW_RUN_DIR = path.join(WORKFLOW_DIR, "runs");
const WORKFLOW_GRAPH_DIR = path.join(WORKFLOW_DIR, "graphs");
const PI_LIVE_SESSION_DIR = "live-sessions";
const DEFAULT_MAX_AGENTS = 64;
const HARD_MAX_AGENTS = 1000;
const DEFAULT_CONCURRENCY = 4;
const HARD_MAX_CONCURRENCY = 16;
const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_WORKFLOW_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_SYNC_TIMEOUT_MS = 5_000;
const PI_SESSION_HEARTBEAT_MS = 5_000;
const PI_SESSION_STALE_MS = 20_000;
const MAX_TOOL_TEXT = 24_000;
const MAX_AGENT_OUTPUT_IN_RESULT = 24_000;
const WORKFLOW_STATUS_KEY = "dynamic-workflows";
const WORKFLOW_WIDGET_KEY = "dynamic-workflows";
const ULTRACODE_STATUS_KEY = "dynamic-workflows-ultracode";
// Best-effort inter-extension hook used by extensions/effort/index.ts for `/effort ultracode`.
const ULTRACODE_MODE_EVENT = "pi-dynamic-workflows:ultracode-mode";
const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Resumable / idempotent runs: host-side content-address cache journal.
const JOURNAL_FILE = "journal.jsonl";
const JOURNAL_VERSION = 4;
const MAX_JOURNALED_STREAM = 200_000;

type WorkflowScope = "project" | "global";
type WorkflowScopeInput = WorkflowScope | "auto";

const TOOL_ACTIONS = ["list", "template", "read", "write", "run", "start", "resume", "cancel", "delete", "graph", "runs", "view"] as const;
const WORKFLOW_SCOPE_INPUTS = ["auto", "project", "global"] as const;

type ToolAction = (typeof TOOL_ACTIONS)[number];

interface DynamicWorkflowToolParams {
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

interface WorkflowFile {
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

interface RunLimits {
	concurrency: number;
	maxAgents: number;
	timeoutMs: number;
	agentTimeoutMs: number;
	syncTimeoutMs: number;
}

interface AgentPhaseInfo {
	id: number;
	index: number;
	total: number;
	label?: string;
}

interface AgentOptions {
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

const DEFAULT_AGENT_WEB_SEARCH_TOOL = "web_search";
const DEFAULT_WEB_SEARCH_EXTENSION_PACKAGE = "pi-codex-web-search";
const DEFAULT_CONTEXT7_SKILL_NAME = "context7-cli";
const READ_ONLY_AGENT_TOOLS = ["read", "grep", "find", "ls"];

const BUILTIN_AGENT_PERSONAS: Record<string, AgentOptions> = {
	explore: {
		tools: READ_ONLY_AGENT_TOOLS,
		thinking: "medium",
		systemPrompt: "Explore broadly but stay evidence-based. Prefer read-only inspection, cite files/lines, and call out uncertainty.",
	},
	reviewer: {
		tools: READ_ONLY_AGENT_TOOLS,
		thinking: "high",
		systemPrompt: "Act as a skeptical code reviewer. Look for correctness, security, concurrency, and maintainability risks. Do not edit files; cite concrete evidence.",
	},
	planner: {
		tools: READ_ONLY_AGENT_TOOLS,
		thinking: "high",
		systemPrompt: "Act as a careful planner. Decompose the task, identify dependencies and risks, and propose a minimal verifiable plan with clear trade-offs.",
	},
	implementer: {
		tools: READ_ONLY_AGENT_TOOLS,
		thinking: "medium",
		systemPrompt: "Act as an implementer designing a concrete patch. Prefer minimal changes, preserve existing behavior, and explain verification steps. Do not edit files unless explicitly allowed by the caller.",
	},
	researcher: {
		tools: READ_ONLY_AGENT_TOOLS,
		thinking: "high",
		systemPrompt: "Act as a researcher. Gather independent evidence, compare alternatives, cite sources or files, and separate facts from assumptions.",
	},
};

const PERSONA_OPTION_KEYS = new Set<keyof AgentOptions>([
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

interface SubagentResult {
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

interface BashResult {
	ok: boolean;
	code: number;
	killed: boolean;
	elapsedMs: number;
	stdout: string;
	stderr: string;
}

interface WorkflowLogEntry {
	time: string;
	message: string;
	details?: unknown;
}

type WorkflowRunState = "running" | "completed" | "failed" | "cancelled" | "stale";

interface WorkflowRunResult {
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

interface JournalRecord {
	v: number;
	key: string;
	occ: number;
	method: "agent" | "bash";
	codeHash: string;
	ts: string;
	result: SubagentResult | BashResult;
}

type JournalCache = Map<string, Array<SubagentResult | BashResult>>;

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

interface WorkflowRunStatus {
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

type WorkflowRunRecord = WorkflowRunResult | WorkflowRunStatus;

interface ActiveWorkflowRun {
	runId: string;
	runDir: string;
	started: number;
	workflow: WorkflowFile;
	controller: AbortController;
	promise?: Promise<WorkflowRunResult>;
}

const activeRuns = new Map<string, ActiveWorkflowRun>();

class AsyncMutex {
	private tail: Promise<void> = Promise.resolve();

	async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
		const previous = this.tail;
		let release!: () => void;
		this.tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await fn();
		} finally {
			release();
		}
	}
}

const appendFileMutexes = new Map<string, AsyncMutex>();

function mutexForAppendFile(filePath: string): AsyncMutex {
	const key = path.resolve(filePath);
	let mutex = appendFileMutexes.get(key);
	if (!mutex) {
		mutex = new AsyncMutex();
		appendFileMutexes.set(key, mutex);
	}
	return mutex;
}

async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
	const file = path.resolve(filePath);
	await mutexForAppendFile(file).runExclusive(async () => {
		await fs.appendFile(file, `${safeJson(value, 0)}\n`, "utf8");
	});
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
	agents(items: Array<string | AgentSpec>, options?: AgentOptions & { concurrency?: number; settle?: false }): Promise<SubagentResult[]>;
	agents(items: Array<string | AgentSpec>, options: AgentOptions & { concurrency?: number; settle: true }): Promise<Array<SubagentResult | null>>;
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
			description: "Workflow name/path relative to the workflow directory (.js is added when omitted), run id for view/cancel/resume (defaults to latest for resume), or pattern key for action=template.",
		}),
	),
	scope: Type.Optional(
		StringEnum(WORKFLOW_SCOPE_INPUTS, {
			description: "Use project .pi/workflows, global ~/.pi/agent/workflows, or auto resolution.",
		}),
	),
	code: Type.Optional(Type.String({ description: "JavaScript workflow source for action=write." })),
	input: Type.Optional(Type.Any({ description: "JSON-serializable input passed to action=run/start workflow(ctx, input)." })),
	background: Type.Optional(Type.Boolean({ description: "Compatibility flag for action=run/resume. In persistent TUI/RPC sessions, workflows always start in background; print/json mode falls back to foreground because no background session stays alive." })),
	force: Type.Optional(Type.Boolean({ description: "For action=resume, allow resuming an already completed run (re-runs only uncached calls)." })),
	concurrency: Type.Optional(
		Type.Integer({ minimum: 1, maximum: HARD_MAX_CONCURRENCY, description: "Default subagent concurrency." }),
	),
	maxAgents: Type.Optional(
		Type.Integer({ minimum: 1, maximum: HARD_MAX_AGENTS, description: "Maximum subagents a workflow may spawn." }),
	),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, description: "Overall workflow timeout in milliseconds." })),
	agentTimeoutMs: Type.Optional(
		Type.Integer({ minimum: 1_000, description: "Default timeout for each subagent in milliseconds." }),
	),
});

function text(content: string) {
	return { type: "text" as const, text: content };
}

function truncate(value: string, max = MAX_TOOL_TEXT): string {
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(0, max - 120))}\n\n...[truncated ${value.length - max} chars]`;
}

function safeJson(value: unknown, indent = 2): string {
	const seen = new WeakSet<object>();
	return JSON.stringify(
		value,
		(_key, current) => {
			if (typeof current === "bigint") return current.toString();
			if (typeof current === "object" && current !== null) {
				if (seen.has(current)) return "[Circular]";
				seen.add(current);
			}
			return current;
		},
		indent,
	);
}

function stringify(value: unknown, max = MAX_TOOL_TEXT): string {
	if (typeof value === "string") return truncate(value, max);
	try {
		return truncate(safeJson(value), max);
	} catch (err) {
		return truncate(String(err), max);
	}
}

function extractTextFromMessageContent(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts = content.map((part) => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object") {
				const record = part as Record<string, unknown>;
				if ((record.type === "text" || record.type === undefined) && typeof record.text === "string") return record.text;
			}
			return "";
		});
		return parts.join("");
	}
	if (content && typeof content === "object") {
		const record = content as Record<string, unknown>;
		if ((record.type === "text" || record.type === undefined) && typeof record.text === "string") return record.text;
	}
	return undefined;
}

function extractAssistantTextFromMessage(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const record = message as Record<string, unknown>;
	if (record.role !== "assistant") return undefined;
	return extractTextFromMessageContent(record.content);
}

function parsePiJsonModeOutput(stdout: string): { ok: true; output: string } | { ok: false; warning: string } {
	return parsePiJsonModeOutputInternal(stdout, false);
}

function parsePiJsonModeOutputLenient(stdout: string): { ok: true; output: string } | { ok: false; warning: string } {
	return parsePiJsonModeOutputInternal(stdout, true);
}

function parsePiJsonModeOutputInternal(stdout: string, lenient: boolean): { ok: true; output: string } | { ok: false; warning: string } {
	const lines = stdout.split(/\r?\n/).filter((line) => line.trim());
	if (lines.length === 0) return { ok: false, warning: "empty JSON event stream" };
	let lastAssistantText: string | undefined;
	let skippedInvalid = 0;
	for (let i = 0; i < lines.length; i++) {
		let event: unknown;
		try {
			event = JSON.parse(lines[i]!);
		} catch (err) {
			if (lenient) {
				skippedInvalid++;
				continue;
			}
			return { ok: false, warning: `invalid JSON event line ${i + 1}: ${err instanceof Error ? err.message : String(err)}` };
		}
		if (!event || typeof event !== "object") continue;
		const record = event as Record<string, unknown>;
		if (record.type === "agent_end" && Array.isArray(record.messages)) {
			for (const message of record.messages) {
				const textValue = extractAssistantTextFromMessage(message);
				if (textValue !== undefined) lastAssistantText = textValue;
			}
			continue;
		}
		if (record.type === "turn_end" || record.type === "message_end" || record.type === "message_update") {
			const textValue = extractAssistantTextFromMessage(record.message);
			if (textValue !== undefined) lastAssistantText = textValue;
		}
	}
	if (lastAssistantText === undefined) {
		return { ok: false, warning: skippedInvalid ? `no assistant text found in complete JSON events (${skippedInvalid} partial/invalid line(s) ignored)` : "no assistant text found in JSON event stream" };
	}
	return { ok: true, output: lastAssistantText.trim() };
}

function makeStructuredOutputSystemPrompt(schema: unknown): string {
	return [
		"You must respond with ONLY one valid JSON value that matches the JSON Schema below.",
		"Do not include Markdown fences, prose, comments, or any text outside the JSON value.",
		"If evidence is insufficient, still return a JSON value matching the schema and encode uncertainty inside the fields.",
		"JSON Schema:",
		safeJson(schema),
	].join("\n");
}

function appendSystemPromptOption(options: AgentOptions, addition: string): AgentOptions {
	return {
		...options,
		appendSystemPrompt: options.appendSystemPrompt ? `${options.appendSystemPrompt}\n\n${addition}` : addition,
	};
}

const AGENT_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BASE_AGENT_ENV_KEYS = ["PATH", "HOME", "SHELL", "TERM", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE"];

interface AgentEnvAccess {
	keyNames: string[];
	missingKeys: string[];
	values: Record<string, string>;
	isolatedEnv: boolean;
	useEnvCommand: boolean;
}

function uniqueStringList(values: Iterable<string | undefined>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (!trimmed) continue;
		if (!AGENT_ENV_NAME_RE.test(trimmed)) throw new Error(`Invalid agent key/env name: ${trimmed}`);
		if (!seen.has(trimmed)) {
			seen.add(trimmed);
			out.push(trimmed);
		}
	}
	return out;
}

function normalizeAgentEnvAccess(options: AgentOptions): AgentEnvAccess {
	const inlineEnv = options.env ?? {};
	const inlineKeys = Object.keys(inlineEnv);
	for (const key of inlineKeys) {
		if (!AGENT_ENV_NAME_RE.test(key)) throw new Error(`Invalid agent env name: ${key}`);
	}
	const keyNames = uniqueStringList([...(options.keys ?? []), ...inlineKeys]);
	const hasScopedEnv = keyNames.length > 0 || options.inheritEnv === false;
	const isolatedEnv = options.inheritEnv === false || (hasScopedEnv && options.inheritEnv !== true);
	const useEnvCommand = hasScopedEnv;
	const values: Record<string, string> = {};
	const missingKeys: string[] = [];
	if (useEnvCommand && isolatedEnv) {
		for (const key of BASE_AGENT_ENV_KEYS) {
			const value = process.env[key];
			if (value !== undefined) values[key] = value;
		}
		if (!values.PATH) values.PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
	}
	for (const key of keyNames) {
		if (Object.prototype.hasOwnProperty.call(inlineEnv, key)) values[key] = String(inlineEnv[key]);
		else if (process.env[key] !== undefined) values[key] = process.env[key]!;
		else missingKeys.push(key);
	}
	return { keyNames, missingKeys, values, isolatedEnv, useEnvCommand };
}

function formatAgentAccessMarkdown(options: AgentOptions, envAccess: AgentEnvAccess): string {
	const list = (values: string[] | undefined, fallback = "default") => values && values.length ? values.join(", ") : fallback;
	const skillAccess = options.skills?.length
		? `${options.skills.join(", ")}${options.includeSkills === true ? " + discovery" : " (explicit only)"}`
		: options.includeSkills === false ? "disabled" : "default discovery";
	const extensionAccess = options.extensions?.length
		? `${options.extensions.join(", ")}${options.includeExtensions === true ? " + discovery" : " (explicit only)"}`
		: options.includeExtensions === true ? "default discovery" : "disabled";
	return [
		`- tools: ${list(options.tools)}`,
		`- excludeTools: ${list(options.excludeTools, "none")}`,
		`- skills: ${skillAccess}`,
		`- extensions: ${extensionAccess}`,
		`- keys: ${envAccess.keyNames.length ? `${envAccess.keyNames.join(", ")} (values redacted)` : envAccess.useEnvCommand ? "none selected" : "default inherited environment"}`,
		...(envAccess.missingKeys.length ? [`- missingKeys: ${envAccess.missingKeys.join(", ")}`] : []),
		`- env: ${envAccess.useEnvCommand ? (envAccess.isolatedEnv ? "isolated + selected keys" : "inherited + selected overrides") : "process default"}`,
	].join("\n");
}

function sanitizeEnvForCache(env: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!env) return undefined;
	const out: Record<string, string> = {};
	for (const key of Object.keys(env).sort()) out[key] = "[set]";
	return out;
}

function shellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function createAgentEnvWrapper(envAccess: AgentEnvAccess): Promise<{ path: string; dir: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workflow-agent-env-"));
	const scriptPath = path.join(dir, "run-agent.sh");
	const lines = ["#!/usr/bin/env bash", "set -euo pipefail"];
	if (envAccess.isolatedEnv) {
		lines.push(
			"while IFS='=' read -r name _; do",
			"  case \"$name\" in BASH*|EUID|PPID|SHELLOPTS|UID) ;; *) unset \"$name\" 2>/dev/null || true ;; esac",
			"done < <(env)",
		);
	}
	for (const key of Object.keys(envAccess.values).sort()) lines.push(`export ${key}=${shellSingleQuote(envAccess.values[key] ?? "")}`);
	lines.push("exec \"$@\"");
	await fs.writeFile(scriptPath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o700 });
	return { path: scriptPath, dir };
}

function sanitizePersonaOptions(value: unknown): AgentOptions {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Persona files must contain a JSON object.");
	const source = value as Record<string, unknown>;
	const out: AgentOptions = {};
	for (const key of PERSONA_OPTION_KEYS) {
		if (source[key] !== undefined) (out as Record<string, unknown>)[key] = source[key];
	}
	return out;
}

function mergePersonaOptions(persona: AgentOptions, options: AgentOptions): AgentOptions {
	const appendSystemPrompt = [persona.appendSystemPrompt, options.appendSystemPrompt].filter((part): part is string => typeof part === "string" && part.length > 0).join("\n\n");
	return {
		...persona,
		...options,
		...(appendSystemPrompt ? { appendSystemPrompt } : {}),
	};
}

function normalizePersonaName(agentType: string): string {
	const name = agentType.trim();
	if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error("agentType may only contain letters, numbers, '.', '_', and '-'.");
	return name;
}

async function loadProjectPersona(ctx: ExtensionContext, agentType: string): Promise<AgentOptions | undefined> {
	if (!ctx.isProjectTrusted()) return undefined;
	const name = normalizePersonaName(agentType);
	const file = path.join(ctx.cwd, CONFIG_DIR_NAME, "personas", `${name}.json`);
	try {
		return sanitizePersonaOptions(JSON.parse(await fs.readFile(file, "utf8")));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`Failed to load persona ${agentType}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function applyPersonaOptions(ctx: ExtensionContext, options: AgentOptions): Promise<AgentOptions> {
	if (!options.agentType) return { ...options };
	const name = normalizePersonaName(options.agentType);
	const projectPersona = await loadProjectPersona(ctx, name);
	const persona = projectPersona ?? BUILTIN_AGENT_PERSONAS[name.toLowerCase()];
	if (!persona) throw new Error(`Unknown agentType: ${options.agentType}`);
	return mergePersonaOptions(persona, options);
}

function appendUniqueValues(values: string[] | undefined, additions: string[]): string[] {
	const out = [...(values ?? [])];
	const seen = new Set(out);
	for (const value of additions) {
		if (!seen.has(value)) {
			seen.add(value);
			out.push(value);
		}
	}
	return out;
}

function existingRealPath(candidate: string): string | undefined {
	try {
		if (!existsSync(candidate)) return undefined;
		return realpathSync(candidate);
	} catch {
		return undefined;
	}
}

async function resolvePiPackageExtensionPaths(packageRoot: string): Promise<string[]> {
	try {
		const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")) as { pi?: { extensions?: unknown } };
		const extensions = manifest.pi?.extensions;
		if (Array.isArray(extensions)) {
			const resolved = extensions
				.filter((entry): entry is string => typeof entry === "string")
				.map((entry) => existingRealPath(path.resolve(packageRoot, entry)))
				.filter((entry): entry is string => !!entry);
			if (resolved.length) return resolved;
		}
	} catch {
		// Fall back to conventional entrypoints below.
	}
	const fallback = existingRealPath(path.join(packageRoot, "src", "index.ts")) ?? existingRealPath(path.join(packageRoot, "index.ts"));
	return fallback ? [fallback] : [];
}

async function resolveDefaultWebSearchExtensions(ctx: ExtensionContext): Promise<string[]> {
	const packageRoots = appendUniqueValues(undefined, [
		path.join(getAgentDir(), "npm", "node_modules", DEFAULT_WEB_SEARCH_EXTENSION_PACKAGE),
		path.join(ctx.cwd, "node_modules", DEFAULT_WEB_SEARCH_EXTENSION_PACKAGE),
	]);
	const extensions: string[] = [];
	for (const packageRoot of packageRoots) {
		if (!existsSync(packageRoot)) continue;
		extensions.push(...await resolvePiPackageExtensionPaths(packageRoot));
	}
	return appendUniqueValues(undefined, extensions);
}

function resolveDefaultContext7Skill(ctx: ExtensionContext): string | undefined {
	const skillRoots = appendUniqueValues(undefined, [
		path.join(ctx.cwd, ".agents", "skills", DEFAULT_CONTEXT7_SKILL_NAME),
		path.join(ctx.cwd, CONFIG_DIR_NAME, "skills", DEFAULT_CONTEXT7_SKILL_NAME),
		path.join(getAgentDir(), "skills", DEFAULT_CONTEXT7_SKILL_NAME),
		path.join(os.homedir(), ".agents", "skills", DEFAULT_CONTEXT7_SKILL_NAME),
		path.join(os.homedir(), ".pi", "agent", "skills", DEFAULT_CONTEXT7_SKILL_NAME),
	]);
	for (const skillRoot of skillRoots) {
		if (existsSync(path.join(skillRoot, "SKILL.md"))) return existingRealPath(skillRoot) ?? skillRoot;
	}
	return undefined;
}

async function applyDefaultAgentAccess(ctx: ExtensionContext, options: AgentOptions): Promise<AgentOptions> {
	const out: AgentOptions = { ...options };
	let webSearchExtensions: string[] = [];
	if (out.includeExtensions !== false) {
		webSearchExtensions = await resolveDefaultWebSearchExtensions(ctx);
		if (out.includeExtensions !== true && webSearchExtensions.length) out.extensions = appendUniqueValues(out.extensions, webSearchExtensions);
	}
	const hasExplicitToolAllowlist = Array.isArray(out.tools) && out.tools.length > 0;
	const excludesWebSearch = out.excludeTools?.includes(DEFAULT_AGENT_WEB_SEARCH_TOOL) === true;
	const webSearchAvailable = out.includeExtensions === true || webSearchExtensions.length > 0 || (out.extensions ?? []).some((extensionPath) => /web[-_]?search|codex-web-search/i.test(extensionPath));
	if (hasExplicitToolAllowlist && webSearchAvailable && !excludesWebSearch) {
		out.tools = appendUniqueValues(out.tools, [DEFAULT_AGENT_WEB_SEARCH_TOOL]);
	}
	if (out.includeSkills !== false && out.skills?.length) {
		const context7Skill = resolveDefaultContext7Skill(ctx);
		if (context7Skill) out.skills = appendUniqueValues(out.skills, [context7Skill]);
	}
	return out;
}

function parseJsonText(textValue: string): { ok: true; data: unknown } | { ok: false; error: string } {
	try {
		return { ok: true, data: JSON.parse(textValue) };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

function balancedJsonCandidate(textValue: string): string | undefined {
	const starts = [textValue.indexOf("{"), textValue.indexOf("[")].filter((index) => index >= 0).sort((a, b) => a - b);
	for (const start of starts) {
		const stack: string[] = [];
		let inString = false;
		let escaped = false;
		for (let i = start; i < textValue.length; i++) {
			const ch = textValue[i]!;
			if (inString) {
				if (escaped) escaped = false;
				else if (ch === "\\") escaped = true;
				else if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') {
				inString = true;
				continue;
			}
			if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
			else if (ch === "}" || ch === "]") {
				if (stack.pop() !== ch) break;
				if (stack.length === 0) return textValue.slice(start, i + 1);
			}
		}
	}
	return undefined;
}

function extractJsonCandidate(output: string): { ok: true; data: unknown } | { ok: false; error: string } {
	const trimmed = output.trim();
	if (!trimmed) return { ok: false, error: "empty output" };
	const direct = parseJsonText(trimmed);
	if (direct.ok) return direct;
	const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
	for (const match of trimmed.matchAll(fencePattern)) {
		const fenced = parseJsonText(match[1]!.trim());
		if (fenced.ok) return fenced;
	}
	const balanced = balancedJsonCandidate(trimmed);
	if (balanced) {
		const parsed = parseJsonText(balanced);
		if (parsed.ok) return parsed;
		return { ok: false, error: `balanced JSON candidate did not parse: ${parsed.error}` };
	}
	return { ok: false, error: `could not parse JSON output: ${direct.error}` };
}

function formatSchemaValidationErrors(schema: unknown, data: unknown): string[] {
	try {
		const valueApi = Value as unknown as { Errors(schema: unknown, value: unknown): Iterable<unknown> };
		const errors = [...valueApi.Errors(schema, data)].slice(0, 8);
		return errors.map((error) => {
			if (!error || typeof error !== "object") return String(error);
			const record = error as Record<string, unknown>;
			const location = record.path ?? record.instancePath ?? record.schemaPath ?? "";
			const message = record.message ?? safeJson(record, 0);
			return `${location ? `${location}: ` : ""}${String(message)}`;
		});
	} catch (err) {
		return [`schema validation failed: ${err instanceof Error ? err.message : String(err)}`];
	}
}

function validateStructuredData(schema: unknown, data: unknown): { ok: true } | { ok: false; errors: string[] } {
	try {
		const valueApi = Value as unknown as { Check(schema: unknown, value: unknown): boolean };
		if (valueApi.Check(schema, data)) return { ok: true };
		return { ok: false, errors: formatSchemaValidationErrors(schema, data) };
	} catch (err) {
		return { ok: false, errors: [`schema validation failed: ${err instanceof Error ? err.message : String(err)}`] };
	}
}

function formatSchemaRetryPrompt(prompt: string, error: string): string {
	return `${prompt}\n\nThe previous response did not match the required JSON schema. Return ONLY a corrected JSON value, with no Markdown or prose. Validation errors:\n${error}`;
}

function slugify(value: string): string {
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

function getRunRoots(ctx: ExtensionContext): string[] {
	const roots = [getRunRoot(ctx), getGlobalRunRoot(ctx)];
	return [...new Set(roots)];
}

function getGraphRoot(ctx: ExtensionContext): string {
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

async function ensureDir(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
}

async function walkWorkflowFiles(root: string, options: { skipReservedTopLevelDirs?: boolean } = {}): Promise<string[]> {
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
		for (const file of await walkWorkflowFiles(location.root, { skipReservedTopLevelDirs: location.kind === "workflow" })) {
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

async function resolveWorkflow(
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
		const file = resolveInsideRoot(location.root, path.join(location.root, relativePath), relativePath, "workflow directory");
		return { name: workflowDisplayName(relativePath), scope: targetScope, path: file, relativePath };
	}

	const candidates = scope === "auto" ? locations : locations.filter((loc) => loc.scope === scope);
	for (const location of candidates) {
		if (!location.trusted) continue;
		const file = path.join(location.root, relativePath);
		if (existsSync(file)) {
			const safeFile = resolveInsideRoot(location.root, file, relativePath, "workflow directory");
			return { name: workflowDisplayName(relativePath), scope: location.scope, path: safeFile, relativePath };
		}
	}

	if (scope === "project" && !ctx.isProjectTrusted()) requireTrustedProject(ctx);
	throw new Error(`Workflow not found: ${name}`);
}

function looksLikeJson(value: string): boolean {
	return /^(?:[\[{\"]|true\b|false\b|null\b|-?\d)/.test(value.trim());
}

function parsePatternFlag(raw: string | undefined): string | undefined {
	const value = raw?.trim();
	if (!value) return undefined;
	const match = /(?:^|\s)--pattern(?:=|\s+)([^\s]+)/.exec(value) ?? /(?:^|\s)--from-pattern(?:=|\s+)([^\s]+)/.exec(value);
	return match?.[1]?.replace(/^['\"]|['\"]$/g, "");
}

function parseCliJsonOrText(raw: string | undefined, options: { strictJson?: boolean } = {}): unknown {
	const value = raw?.trim();
	if (!value) return {};
	try {
		return JSON.parse(value);
	} catch (err) {
		if (options.strictJson || looksLikeJson(value)) {
			throw new Error(`Invalid JSON input: ${err instanceof Error ? err.message : String(err)}`);
		}
		return { text: value };
	}
}

function limitParamsFromInput(input: unknown): Partial<DynamicWorkflowToolParams> {
	if (!input || typeof input !== "object" || Array.isArray(input)) return {};
	const record = input as Record<string, unknown>;
	const out: Partial<DynamicWorkflowToolParams> = {};
	for (const key of ["concurrency", "maxAgents", "timeoutMs", "agentTimeoutMs"] as const) {
		if (typeof record[key] === "number" && Number.isFinite(record[key])) out[key] = record[key];
	}
	return out;
}

function buildLimits(params: Partial<DynamicWorkflowToolParams> = {}): RunLimits {
	const concurrency = Math.min(Math.max(Math.floor(params.concurrency ?? DEFAULT_CONCURRENCY), 1), HARD_MAX_CONCURRENCY);
	const maxAgents = Math.min(Math.max(Math.floor(params.maxAgents ?? DEFAULT_MAX_AGENTS), 1), HARD_MAX_AGENTS);
	return {
		concurrency,
		maxAgents,
		timeoutMs: Math.max(Math.floor(params.timeoutMs ?? DEFAULT_WORKFLOW_TIMEOUT_MS), 1_000),
		agentTimeoutMs: Math.max(Math.floor(params.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS), 1_000),
		syncTimeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
	};
}

interface CombinedSignal {
	signal: AbortSignal;
	abort(reason?: unknown): void;
	dispose(): void;
}

function abortReasonMessage(signal: AbortSignal): string {
	const reason = signal.reason;
	if (reason instanceof Error) return reason.message;
	if (typeof reason === "string" && reason.trim()) return reason;
	return "Workflow aborted.";
}

function combineSignal(parent: AbortSignal | undefined, timeoutMs: number): CombinedSignal {
	const controller = new AbortController();
	let timeout: NodeJS.Timeout | undefined;
	const abort = (reason?: unknown) => {
		if (!controller.signal.aborted) controller.abort(reason);
	};
	const abortFromParent = () => abort(parent?.reason);
	if (parent?.aborted) abort(parent.reason);
	parent?.addEventListener("abort", abortFromParent, { once: true });
	if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
		timeout = setTimeout(() => abort(new Error(`Workflow timed out after ${Math.round(timeoutMs / 1000)}s.`)), timeoutMs);
	}
	return {
		signal: controller.signal,
		abort,
		dispose() {
			if (timeout) clearTimeout(timeout);
			parent?.removeEventListener("abort", abortFromParent);
		},
	};
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw new Error(abortReasonMessage(signal));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error(abortReasonMessage(signal)));
			return;
		}
		const timeout = setTimeout(done, ms);
		function abort() {
			clearTimeout(timeout);
			reject(new Error(abortReasonMessage(signal)));
		}
		function done() {
			signal.removeEventListener("abort", abort);
			resolve();
		}
		signal.addEventListener("abort", abort, { once: true });
	});
}

async function mapLimit<T, R>(
	items: T[],
	concurrency: number,
	signal: AbortSignal,
	fn: (item: T, index: number) => Promise<R>,
	options?: { onError?: "throw" },
): Promise<R[]>;
async function mapLimit<T, R>(
	items: T[],
	concurrency: number,
	signal: AbortSignal,
	fn: (item: T, index: number) => Promise<R>,
	options: { onError: "null" },
): Promise<Array<R | null>>;
async function mapLimit<T, R>(
	items: T[],
	concurrency: number,
	signal: AbortSignal,
	fn: (item: T, index: number) => Promise<R>,
	options: { onError?: "throw" | "null" } = {},
): Promise<Array<R | null>> {
	const results = new Array<R | null>(items.length);
	const onError = options.onError ?? "throw";
	let next = 0;
	const workerCount = Math.min(Math.max(1, concurrency), items.length || 1);
	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			while (true) {
				throwIfAborted(signal);
				const index = next++;
				if (index >= items.length) return;
				try {
					results[index] = await fn(items[index]!, index);
				} catch (err) {
					if (signal.aborted || onError === "throw") throw err;
					results[index] = null;
				}
			}
		}),
	);
	return results;
}

function createSemaphore(limit: number, signal: AbortSignal) {
	let active = 0;
	let disposed = false;
	const queue: Array<{ resolve: (release: () => void) => void; reject: (error: Error) => void }> = [];

	const makeRelease = () => {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			active = Math.max(0, active - 1);
			drain();
		};
	};

	const abortQueued = () => {
		const error = new Error(abortReasonMessage(signal));
		for (const waiter of queue.splice(0)) waiter.reject(error);
	};

	const drain = () => {
		if (disposed || signal.aborted) {
			abortQueued();
			return;
		}
		while (active < limit && queue.length > 0) {
			const waiter = queue.shift()!;
			active++;
			waiter.resolve(makeRelease());
		}
	};

	const onAbort = () => abortQueued();
	signal.addEventListener("abort", onAbort, { once: true });

	return {
		async acquire(): Promise<() => void> {
			if (disposed || signal.aborted) throw new Error(abortReasonMessage(signal));
			if (active < limit) {
				active++;
				return makeRelease();
			}
			return await new Promise<() => void>((resolve, reject) => {
				queue.push({ resolve, reject });
			});
		},
		dispose(): void {
			disposed = true;
			signal.removeEventListener("abort", onAbort);
			abortQueued();
		},
	};
}

async function createRunDirectory(ctx: ExtensionContext, workflowName: string, started: number): Promise<{ runId: string; runDir: string }> {
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

async function prepareWorkflowRun(ctx: ExtensionContext, workflowName: string, background = false): Promise<PreparedWorkflowRun> {
	const started = Date.now();
	const { runId, runDir } = await createRunDirectory(ctx, workflowName, started);
	await ensureDir(path.join(runDir, "agents"));
	return { started, runId, runDir, background };
}

function isInsidePath(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
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

function shellArg(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function makeModelArg(ctx: ExtensionContext): string | undefined {
	if (!ctx.model) return undefined;
	return `${ctx.model.provider}/${ctx.model.id}`;
}

function transformWorkflowCode(code: string): string {
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
		throw new Error("Only `export default` is supported. Prefer `module.exports = async function workflow(ctx, input) {}`.");
	}
	return output;
}

const WORKFLOW_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");

let nextCallId = 1;
const pending = new Map();

function compact(value, maxChars = 24000) {
  let text;
  if (typeof value === "string") text = value;
  else {
    const seen = new WeakSet();
    text = JSON.stringify(value, (_key, current) => {
      if (typeof current === "bigint") return current.toString();
      if (typeof current === "object" && current !== null) {
        if (seen.has(current)) return "[Circular]";
        seen.add(current);
      }
      return current;
    }, 2);
  }
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 120)) + "\n\n...[truncated " + (text.length - maxChars) + " chars]";
}

function hostCall(method, args) {
  const id = nextCallId++;
  parentPort.postMessage({ type: "call", id, method, args });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

parentPort.on("message", (message) => {
  if (!message || message.type !== "response") return;
  const handler = pending.get(message.id);
  if (!handler) return;
  pending.delete(message.id);
  if (message.ok) handler.resolve(message.result);
  else handler.reject(new Error(message.error || "Workflow host call failed"));
});

function send(type, payload) {
  try {
    parentPort.postMessage({ type, ...payload });
  } catch (err) {
    parentPort.postMessage({ type: "error", error: err && err.stack ? err.stack : String(err) });
  }
}

async function parallel(thunks, concurrency) {
  if (!Array.isArray(thunks)) throw new Error("parallel(thunks) expects an array of functions.");
  const results = new Array(thunks.length).fill(null);
  let next = 0;
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency || 1)), thunks.length || 1);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = next++;
      if (index >= thunks.length) return;
      const thunk = thunks[index];
      if (typeof thunk !== "function") {
        results[index] = null;
        continue;
      }
      try {
        results[index] = await thunk();
      } catch {
        results[index] = null;
      }
    }
  }));
  return results;
}

async function pipeline(items, concurrency, ...stagesAndOptions) {
  if (!Array.isArray(items)) throw new Error("pipeline(items, ...stages) expects an array of items.");
  if (items.length > 4096) throw new Error("pipeline() supports at most 4096 items per call; chunk the work-list explicitly.");
  const maybeOptions = stagesAndOptions.length && typeof stagesAndOptions[stagesAndOptions.length - 1] === "object" && typeof stagesAndOptions[stagesAndOptions.length - 1] !== "function"
    ? stagesAndOptions.pop()
    : undefined;
  const stages = stagesAndOptions;
  if (stages.length === 0) return items.slice();
  if (!stages.every((stage) => typeof stage === "function")) throw new Error("pipeline stages must be functions.");
  const requested = maybeOptions && Number.isFinite(maybeOptions.inFlight) ? maybeOptions.inFlight : concurrency;
  const inFlight = Math.min(Math.max(1, Math.floor(requested || 1)), Math.max(1, concurrency || 1), items.length || 1);
  const results = new Array(items.length).fill(null);
  let next = 0;
  await Promise.all(Array.from({ length: inFlight }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      const original = items[index];
      try {
        let value = original;
        for (const stage of stages) value = await stage(value, original, index);
        results[index] = value;
      } catch {
        results[index] = null;
      }
    }
  }));
  return results;
}

(async () => {
  const moduleObj = { exports: {} };
  const limits = Object.freeze({ ...workerData.limits });
  const ctx = {
    cwd: workerData.cwd,
    runId: workerData.runId,
    runDir: workerData.runDir,
    input: workerData.input,
    limits,
    log: (...args) => hostCall("log", args),
    agent: (prompt, options) => hostCall("agent", [prompt, options]),
    agents: (items, options) => hostCall("agents", [items, options]),
    workflow: (name, input) => hostCall("workflow", [name, input]),
    parallel: (thunks) => parallel(thunks, limits.concurrency),
    pipeline: (items, ...stages) => pipeline(items, limits.concurrency, ...stages),
    bash: (command, options) => hostCall("bash", [command, options]),
    readFile: (filePath, encoding) => hostCall("readFile", [filePath, encoding]),
    writeFile: (filePath, data) => hostCall("writeFile", [filePath, data]),
    appendFile: (filePath, data) => hostCall("appendFile", [filePath, data]),
    listFiles: (dir, options) => hostCall("listFiles", [dir, options]),
    writeArtifact: (name, data) => hostCall("writeArtifact", [name, data]),
    appendArtifact: (name, data) => hostCall("appendArtifact", [name, data]),
    sleep: (ms) => hostCall("sleep", [ms]),
    json: compact,
    compact,
  };

  const workflowConsole = {
    log: (...args) => void hostCall("log", [args.map((arg) => typeof arg === "string" ? arg : compact(arg)).join(" ")]),
    warn: (...args) => void hostCall("log", [args.map((arg) => typeof arg === "string" ? arg : compact(arg)).join(" ")]),
    error: (...args) => void hostCall("log", [args.map((arg) => typeof arg === "string" ? arg : compact(arg)).join(" ")]),
  };

  const sandbox = {
    module: moduleObj,
    exports: moduleObj.exports,
    console: workflowConsole,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Buffer,
    structuredClone,
    fetch: globalThis.fetch,
    AbortController,
    AbortSignal,
    crypto: globalThis.crypto,
  };

  try {
    sandbox.parallel = ctx.parallel;
    sandbox.pipeline = ctx.pipeline;
    const context = vm.createContext(sandbox, { name: "pi-workflow:" + workerData.workflowName });
    const script = new vm.Script(workerData.code, { filename: workerData.filePath });
    script.runInContext(context, { timeout: limits.syncTimeoutMs });

    let exported = moduleObj.exports;
    if (exported && typeof exported === "object" && typeof exported.default === "function") exported = exported.default;
    if (typeof exported !== "function") {
      const maybeMain = sandbox.main || sandbox.workflow;
      if (typeof maybeMain === "function") exported = maybeMain;
    }
    if (typeof exported !== "function") {
      throw new Error("Workflow must export a function: module.exports = async function workflow(ctx, input) { ... }.");
    }

    sandbox.__workflow = exported;
    sandbox.__ctx = ctx;
    sandbox.__input = workerData.input;
    const result = vm.runInContext("__workflow(__ctx, __input)", context, { timeout: limits.syncTimeoutMs });
    send("result", { result: await Promise.resolve(result) });
  } catch (err) {
    send("error", { error: err && err.stack ? err.stack : String(err) });
  }
})();
`;

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
					safePost({ type: "response", id: message.id, ok: false, error: abortReasonMessage(signal) });
					return;
				}
				const method = message.method as keyof WorkflowRuntimeApi;
				if (!allowedMethods.has(method) || typeof api[method] !== "function") {
					safePost({ type: "response", id: message.id, ok: false, error: `Unsupported workflow API method: ${String(method)}` });
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

function formatWorkflowList(files: WorkflowFile[]): string {
	if (files.length === 0) {
		return "No workflows found. Create one with `/workflow new <name>` or dynamic_workflow action=write.";
	}
	return files.map((file) => `- ${file.name} (${file.scope}) — ${file.relativePath}`).join("\n");
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

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.mode === "print") {
		console.log(message);
		return;
	}
	if (ctx.hasUI) ctx.ui.notify(message, type);
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

function workflowProgress(logs: WorkflowLogEntry[]): { agentsStarted: number; agentsDone: number; agentsRunning: number; bashDone: number } {
	let agentsStarted = 0;
	let agentsDone = 0;
	let bashDone = 0;
	for (const logEntry of logs) {
		if (/^agent \d+ start:/.test(logEntry.message)) agentsStarted++;
		if (/^agent \d+ end:/.test(logEntry.message)) agentsDone++;
		if (/^bash end:/.test(logEntry.message)) bashDone++;
	}
	return { agentsStarted, agentsDone, agentsRunning: Math.max(0, agentsStarted - agentsDone), bashDone };
}

function workflowDashboardHint(): string {
	return "/workflows ↓ monitor ← agents Ctrl+Alt+W";
}

function shortWorkflowName(name: string): string {
	return name.length <= 36 ? name : `${name.slice(0, 33)}…`;
}

function formatElapsedMs(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	if (minutes < 60) return `${minutes}m${remainder.toString().padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${(minutes % 60).toString().padStart(2, "0")}m`;
}

function getRunElapsedMs(run: WorkflowRunRecord, state: WorkflowRunState = getRunState(run)): number {
	if (state === "running") {
		const started = new Date(run.startedAt).getTime();
		if (Number.isFinite(started)) return Date.now() - started;
	}
	return run.elapsedMs;
}

function getRunAgentConcurrency(run: WorkflowRunRecord): number | undefined {
	return typeof run.agentConcurrency === "number" && Number.isFinite(run.agentConcurrency) ? Math.max(0, Math.floor(run.agentConcurrency)) : undefined;
}

function getRunParallelAgents(run: WorkflowRunRecord, agents?: AgentMonitorModel[]): number {
	if (typeof run.parallelAgents === "number" && Number.isFinite(run.parallelAgents)) return Math.max(0, Math.floor(run.parallelAgents));
	if (getRunState(run) === "running" && agents) return agents.filter((agent) => agent.state === "running").length;
	return 0;
}

function estimatePeakParallelAgents(agents: AgentMonitorModel[]): number | undefined {
	const points: Array<{ t: number; d: number }> = [];
	for (const agent of agents) {
		if (agent.state === "cached") continue;
		const started = agent.startedAt ? new Date(agent.startedAt).getTime() : Number.NaN;
		if (!Number.isFinite(started)) continue;
		points.push({ t: started, d: 1 });
		const ended = agent.endedAt ? new Date(agent.endedAt).getTime() : Number.NaN;
		if (Number.isFinite(ended)) points.push({ t: ended, d: -1 });
	}
	if (points.length === 0) return undefined;
	points.sort((a, b) => a.t - b.t || b.d - a.d);
	let current = 0;
	let peak = 0;
	for (const point of points) {
		current = Math.max(0, current + point.d);
		peak = Math.max(peak, current);
	}
	return peak;
}

function getRunPeakParallelAgents(run: WorkflowRunRecord, agents?: AgentMonitorModel[]): number | undefined {
	if (typeof run.peakParallelAgents === "number" && Number.isFinite(run.peakParallelAgents)) return Math.max(0, Math.floor(run.peakParallelAgents));
	return agents ? estimatePeakParallelAgents(agents) : undefined;
}

function formatParallelAgents(run: WorkflowRunRecord, agents?: AgentMonitorModel[]): string {
	const current = getRunParallelAgents(run, agents);
	const limit = getRunAgentConcurrency(run);
	const peak = getRunPeakParallelAgents(run, agents);
	const currentText = limit && limit > 0 ? `${current}/${limit} running` : `${current} running`;
	const peakText = peak === undefined ? "" : ` • peak:${peak}`;
	return `${currentText}${peakText}`;
}

function formatParallelAgentsCompact(run: WorkflowRunRecord, agents?: AgentMonitorModel[]): string {
	const current = getRunParallelAgents(run, agents);
	const limit = getRunAgentConcurrency(run);
	const peak = getRunPeakParallelAgents(run, agents);
	if (getRunState(run) === "running") return limit && limit > 0 ? `${current}/${limit}` : String(current);
	return peak === undefined ? "-" : `peak:${peak}`;
}

function isActiveRunRecord(run: WorkflowRunRecord): boolean {
	return getRunState(run) === "running" && activeRuns.has(run.runId);
}

function canCancelRun(run: WorkflowRunRecord): boolean {
	return isActiveRunRecord(run);
}

function padRightVisible(value: string, width: number): string {
	const maxWidth = Math.max(1, width);
	const truncated = visibleWidth(value) > maxWidth ? truncateToWidth(value, maxWidth, "") : value;
	return truncated + " ".repeat(Math.max(0, maxWidth - visibleWidth(truncated)));
}

function renderSafeInline(value: string): string {
	return value
		.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
		.replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\r\n\t]+/g, " ")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function setWorkflowIdleStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(WORKFLOW_STATUS_KEY, ctx.ui.theme.fg("dim", "wf"));
}

function setWorkflowRunningStatus(ctx: ExtensionContext, workflowName: string, logs: WorkflowLogEntry[], status?: WorkflowRunStatus): void {
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
	ctx.ui.setStatus(WORKFLOW_STATUS_KEY, `${theme.fg("accent", "▶ wf")} ${theme.fg("dim", `${count} bg ${workflowDashboardHint()}`)}`);
}

function clearWorkflowWidget(ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.setWidget(WORKFLOW_WIDGET_KEY, undefined);
}

function formatLiveRunView(logs: WorkflowLogEntry[], workflowName: string, width = 80, status?: WorkflowRunStatus): string[] {
	if (width <= 0) return [];
	const w = width;
	const { agentsStarted, agentsDone, agentsRunning, bashDone } = workflowProgress(logs);
	const latest = logs.slice(-1)[0];
	const line = (s: string) => truncateToWidth(s, w, "");
	const name = renderSafeInline(shortWorkflowName(workflowName));
	const parallel = status ? formatParallelAgentsCompact(status) : agentsRunning > 0 ? String(agentsRunning) : "0";
	return [
		line(`▶ wf ${name}  agents ${agentsDone}/${agentsStarted}  parallel ${parallel}  bash ${bashDone}  logs ${logs.length}`),
		line(latest ? `${latest.time.slice(11, 19)} ${renderSafeInline(latest.message)}  •  ${workflowDashboardHint()}` : `Open monitor: ${workflowDashboardHint()}`),
	];
}

function setWorkflowWidget(ctx: ExtensionContext, workflowName: string, logs: WorkflowLogEntry[], status?: WorkflowRunStatus): void {
	if (!ctx.hasUI) return;
	if (ctx.mode !== "tui") {
		ctx.ui.setWidget(WORKFLOW_WIDGET_KEY, formatLiveRunView(logs, workflowName, undefined, status), { placement: "belowEditor" });
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

type WorkflowGraphStepKind = "agent" | "artifact" | "barrier" | "fanout" | "file" | "pipeline" | "shell" | "subworkflow";

type WorkflowGraphFanoutUnit = "agents" | "branches" | "lanes";

interface WorkflowGraphFanoutInfo {
	unit: WorkflowGraphFanoutUnit;
	countLabel: string;
	count?: number;
	many: boolean;
	phaseLabel?: string;
	concurrency?: string;
	settle?: boolean;
	stages?: number;
}

interface WorkflowGraphChildCall {
	method: string;
	kind: WorkflowGraphStepKind;
	symbol: string;
	title: string;
	label: string;
	line: number;
	firstArg?: string;
}

interface WorkflowGraphStep {
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

interface WorkflowGraphCall extends WorkflowGraphChildCall {
	start: number;
	end: number;
	snippet: string;
}

interface WorkflowGraphModel {
	workflow: WorkflowFile;
	steps: WorkflowGraphStep[];
	notes: string[];
}

interface WorkflowGraphRenderTheme {
	accent(text: string): string;
	muted(text: string): string;
	success(text: string): string;
	warning(text: string): string;
}

function mermaidLabel(value: string): string {
	return value.replace(/["<>{}\[\]()|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 90) || "step";
}

function graphTextLabel(value: string): string {
	return renderSafeInline(value).slice(0, 96) || "step";
}

function extractFirstStringLiteral(source: string): string | undefined {
	const match = /(?:`([^`]{1,160})`|"([^"\n]{1,160})"|'([^'\n]{1,160})')/.exec(source);
	return match?.[1] ?? match?.[2] ?? match?.[3];
}

function extractDirectStringLiteralArgument(source: string): string | undefined {
	const trimmed = source.trim();
	const match = /^(?:`([^`$]{1,200})`|"([^"\n]{1,200})"|'([^'\n]{1,200})')\s*$/s.exec(trimmed);
	return match?.[1] ?? match?.[2] ?? match?.[3];
}

function isJavaScriptCodePosition(source: string, index: number): boolean {
	let quote: "'" | '"' | "`" | undefined;
	let escaped = false;
	let lineComment = false;
	let blockComment = false;
	for (let i = 0; i < index; i++) {
		const char = source[i]!;
		const next = source[i + 1];
		if (lineComment) {
			if (char === "\n") lineComment = false;
			continue;
		}
		if (blockComment) {
			if (char === "*" && next === "/") {
				blockComment = false;
				i++;
			}
			continue;
		}
		if (quote) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === quote) quote = undefined;
			continue;
		}
		if (char === "/" && next === "/") {
			lineComment = true;
			i++;
			continue;
		}
		if (char === "/" && next === "*") {
			blockComment = true;
			i++;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") quote = char;
	}
	return !quote && !lineComment && !blockComment;
}

function lineNumberAtIndex(source: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) {
		if (source.charCodeAt(i) === 10) line++;
	}
	return line;
}

function findCallEndIndex(source: string, openParenIndex: number): number {
	let depth = 0;
	let quote: "'" | '"' | "`" | undefined;
	let escaped = false;
	let lineComment = false;
	let blockComment = false;
	for (let i = openParenIndex; i < source.length; i++) {
		const char = source[i]!;
		const next = source[i + 1];
		if (lineComment) {
			if (char === "\n") lineComment = false;
			continue;
		}
		if (blockComment) {
			if (char === "*" && next === "/") {
				blockComment = false;
				i++;
			}
			continue;
		}
		if (quote) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "/" && next === "/") {
			lineComment = true;
			i++;
			continue;
		}
		if (char === "/" && next === "*") {
			blockComment = true;
			i++;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char;
			continue;
		}
		if (char === "(") depth++;
		else if (char === ")") {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return Math.min(source.length, openParenIndex + 320);
}

function splitTopLevelArguments(source: string): string[] {
	const args: string[] = [];
	let start = 0;
	let depth = 0;
	let quote: "'" | '"' | "`" | undefined;
	let escaped = false;
	let lineComment = false;
	let blockComment = false;
	for (let i = 0; i < source.length; i++) {
		const char = source[i]!;
		const next = source[i + 1];
		if (lineComment) {
			if (char === "\n") lineComment = false;
			continue;
		}
		if (blockComment) {
			if (char === "*" && next === "/") {
				blockComment = false;
				i++;
			}
			continue;
		}
		if (quote) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "/" && next === "/") {
			lineComment = true;
			i++;
			continue;
		}
		if (char === "/" && next === "*") {
			blockComment = true;
			i++;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char;
			continue;
		}
		if (char === "(" || char === "[" || char === "{") depth++;
		else if (char === ")" || char === "]" || char === "}") depth = Math.max(0, depth - 1);
		else if (char === "," && depth === 0) {
			const arg = source.slice(start, i).trim();
			if (arg) args.push(arg);
			start = i + 1;
		}
	}
	const tail = source.slice(start).trim();
	if (tail) args.push(tail);
	return args;
}

function compactExpressionLabel(value: string, max = 64): string {
	return value.replace(/\s+/g, " ").replace(/,$/, "").trim().slice(0, max) || "dynamic";
}

function countTopLevelArrayItems(expression: string): number | undefined {
	const trimmed = expression.trim();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
	const inner = trimmed.slice(1, -1).trim();
	if (!inner) return 0;
	return splitTopLevelArguments(inner).length;
}

function inferCollectionCardinality(expression: string, fallbackLabel: string): Pick<WorkflowGraphFanoutInfo, "count" | "countLabel" | "many"> {
	const trimmed = expression.trim();
	const literalCount = countTopLevelArrayItems(trimmed);
	if (literalCount !== undefined) return { count: literalCount, countLabel: String(literalCount), many: literalCount > 1 };
	const mapMatch = /^(.+?)\.map\s*\(/s.exec(trimmed);
	if (mapMatch) {
		const source = compactExpressionLabel(mapMatch[1]!, 48);
		return { countLabel: `${source}.length`, many: true };
	}
	if (/\.length\b/.test(trimmed)) return { countLabel: compactExpressionLabel(trimmed, 48), many: true };
	if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\?\.[A-Za-z_$][\w$]*)*$/.test(trimmed)) return { countLabel: `${trimmed}.length`, many: true };
	return { countLabel: fallbackLabel, many: true };
}

function extractObjectOptionValue(options: string | undefined, key: string): string | undefined {
	if (!options) return undefined;
	const property = new RegExp(`\\b${key}\\s*:\\s*([^,}\\n]+)`).exec(options);
	if (property) return compactExpressionLabel(property[1]!, 32);
	const shorthand = new RegExp(`(?:^|[{,]\\s*)${key}(?:\\s*[,}])`).exec(options);
	return shorthand ? key : undefined;
}

function extractObjectBooleanOption(options: string | undefined, key: string): boolean | undefined {
	const raw = extractObjectOptionValue(options, key);
	if (raw === "true") return true;
	if (raw === "false") return false;
	return undefined;
}

function inferWorkflowGraphFanout(method: string, args: string[], phaseIndex: number | undefined): WorkflowGraphFanoutInfo | undefined {
	const firstArg = args[0] ?? "";
	const options = args[1];
	if (method === "agents") {
		const cardinality = inferCollectionCardinality(firstArg, "dynamic");
		return {
			unit: "agents",
			...cardinality,
			...(phaseIndex ? { phaseLabel: `P${phaseIndex}` } : {}),
			...(extractObjectOptionValue(options, "concurrency") ? { concurrency: extractObjectOptionValue(options, "concurrency") } : {}),
			...(extractObjectBooleanOption(options, "settle") === undefined ? {} : { settle: extractObjectBooleanOption(options, "settle") }),
		};
	}
	if (method === "parallel") {
		const cardinality = inferCollectionCardinality(firstArg, "dynamic");
		return { unit: "branches", ...cardinality };
	}
	if (method === "pipeline") {
		const cardinality = inferCollectionCardinality(firstArg, "dynamic");
		return { unit: "lanes", ...cardinality, stages: Math.max(0, args.length - 1) };
	}
	return undefined;
}

function formatWorkflowGraphFanoutSummary(fanout: WorkflowGraphFanoutInfo): string {
	const parts = [`×${fanout.countLabel} ${fanout.unit}`];
	if (fanout.phaseLabel) parts.unshift(fanout.phaseLabel);
	if (fanout.stages !== undefined) parts.push(`${fanout.stages} stages`);
	if (fanout.concurrency) parts.push(fanout.concurrency === "concurrency" ? "concurrency" : `concurrency=${fanout.concurrency}`);
	if (fanout.settle !== undefined) parts.push(`settle:${fanout.settle}`);
	return parts.join(" · ");
}

function summarizeWorkflowGraphChildren(children: WorkflowGraphChildCall[]): string | undefined {
	if (children.length === 0) return undefined;
	const counts = new Map<string, number>();
	for (const child of children) counts.set(child.method, (counts.get(child.method) ?? 0) + 1);
	return Array.from(counts.entries()).map(([method, count]) => `${count}× ctx.${method}`).join(", ");
}

function workflowGraphMethodInfo(method: string): Omit<WorkflowGraphStep, "index" | "label" | "line" | "firstArg" | "children" | "fanout"> {
	if (method === "agents") return { method, kind: "fanout", symbol: "◆", title: "fan-out subagents" };
	if (method === "parallel") return { method, kind: "barrier", symbol: "⧉", title: "parallel barrier" };
	if (method === "pipeline") return { method, kind: "pipeline", symbol: "▣", title: "pipeline lanes" };
	if (method === "agent") return { method, kind: "agent", symbol: "●", title: "subagent" };
	if (method === "workflow") return { method, kind: "subworkflow", symbol: "◇", title: "sub-workflow" };
	if (method === "bash") return { method, kind: "shell", symbol: "$", title: "bash" };
	if (method === "writeArtifact" || method === "appendArtifact") return { method, kind: "artifact", symbol: "▤", title: method === "writeArtifact" ? "write artifact" : "append artifact" };
	return { method, kind: "file", symbol: "◌", title: method.replace(/[A-Z]/g, (char) => ` ${char.toLowerCase()}`) };
}

function buildWorkflowGraphModel(workflow: WorkflowFile, code: string): WorkflowGraphModel {
	const regex = /\bctx\.(parallel|pipeline|agents|agent|workflow|bash|writeArtifact|appendArtifact|readFile|writeFile|appendFile|listFiles)\s*\(/g;
	const calls: WorkflowGraphCall[] = [];
	let match: RegExpExecArray | null;
	while ((match = regex.exec(code)) !== null) {
		if (!isJavaScriptCodePosition(code, match.index)) continue;
		const method = match[1]!;
		const openParenIndex = regex.lastIndex - 1;
		const end = findCallEndIndex(code, openParenIndex);
		const snippet = code.slice(openParenIndex + 1, Math.max(openParenIndex + 1, end - 1));
		const args = splitTopLevelArguments(snippet);
		const firstArg = method === "workflow" ? extractDirectStringLiteralArgument(args[0] ?? "") : extractFirstStringLiteral(snippet);
		const info = workflowGraphMethodInfo(method);
		calls.push({
			...info,
			start: match.index,
			end,
			snippet,
			line: lineNumberAtIndex(code, match.index),
			label: `${info.title}${firstArg ? `: ${graphTextLabel(firstArg)}` : ""}`,
			...(firstArg ? { firstArg: graphTextLabel(firstArg) } : {}),
		});
	}

	const orchestrationParents = new Set(["agents", "parallel", "pipeline"]);
	const childrenByParent = new Map<WorkflowGraphCall, WorkflowGraphChildCall[]>();
	const topLevelCalls: WorkflowGraphCall[] = [];
	for (const call of calls) {
		let parent: WorkflowGraphCall | undefined;
		for (const candidate of calls) {
			if (candidate === call || !orchestrationParents.has(candidate.method)) continue;
			if (candidate.start < call.start && call.end <= candidate.end && (!parent || candidate.start > parent.start)) parent = candidate;
		}
		if (parent) {
			const children = childrenByParent.get(parent) ?? [];
			children.push(call);
			childrenByParent.set(parent, children);
		} else {
			topLevelCalls.push(call);
		}
	}

	const steps: WorkflowGraphStep[] = [];
	let agentPhaseIndex = 0;
	for (const call of topLevelCalls) {
		const args = splitTopLevelArguments(call.snippet);
		const phaseIndex = call.method === "agents" ? ++agentPhaseIndex : undefined;
		const fanout = inferWorkflowGraphFanout(call.method, args, phaseIndex);
		const children = childrenByParent.get(call) ?? [];
		steps.push({
			method: call.method,
			kind: call.kind,
			symbol: call.symbol,
			title: call.title,
			index: steps.length + 1,
			line: call.line,
			label: fanout ? `${call.title} (${formatWorkflowGraphFanoutSummary(fanout)})` : call.label,
			...(call.firstArg ? { firstArg: call.firstArg } : {}),
			children,
			...(fanout ? { fanout } : {}),
		});
	}

	const notes = [
		"Static preview inferred from source-order ctx.* calls; runtime data can differ.",
		"Fan-out counts are static expressions; /workflow view shows runtime P1 i/n totals.",
		"Does not evaluate budget, retries, cache hits, or error paths.",
	];
	if (steps.some((step) => step.children.length > 0)) notes.push("Nested ctx.* calls inside ctx.pipeline/ctx.parallel/ctx.agents are grouped under their orchestration step.");
	if (/\b(for|while)\s*\(/.test(code)) notes.push("Loops detected; repeated calls are shown once in source order.");
	if (/\bif\s*\(|\?[^\n]+:/.test(code)) notes.push("Branches detected; conditional paths are approximate.");
	return { workflow, steps, notes };
}

async function buildWorkflowGraphModelWithSubworkflows(
	ctx: ExtensionContext,
	workflow: WorkflowFile,
	code: string,
	depth = 0,
	seen = new Set<string>(),
): Promise<WorkflowGraphModel> {
	const model = buildWorkflowGraphModel(workflow, code);
	const currentPath = path.resolve(workflow.path);
	const nextSeen = new Set(seen);
	nextSeen.add(currentPath);
	const subworkflowSteps = model.steps.filter((step) => step.kind === "subworkflow");
	if (subworkflowSteps.length > 0) {
		model.notes.push("ctx.workflow() calls with literal names are expanded one level using the referenced workflow file; dynamic names are shown but not resolved.");
	}
	for (const step of subworkflowSteps) {
		if (!step.firstArg) {
			step.subworkflowError = "dynamic sub-workflow name; cannot resolve statically";
			continue;
		}
		if (depth >= 1) {
			step.subworkflowError = "nested sub-workflows are not expanded; runtime composition depth limit is 1";
			continue;
		}
		try {
			const subWorkflow = await resolveWorkflow(ctx, step.firstArg, "auto");
			const subPath = path.resolve(subWorkflow.path);
			if (nextSeen.has(subPath)) {
				step.subworkflowError = `recursive sub-workflow skipped: ${subWorkflow.name}`;
				continue;
			}
			const subCode = await fs.readFile(subWorkflow.path, "utf8");
			step.subworkflow = await buildWorkflowGraphModelWithSubworkflows(ctx, subWorkflow, subCode, depth + 1, nextSeen);
		} catch (err) {
			step.subworkflowError = err instanceof Error ? err.message : String(err);
		}
	}
	return model;
}

function renderWorkflowGraphStepDetail(step: WorkflowGraphStep): string[] {
	const lines: string[] = [];
	if (step.fanout) {
		lines.push(`visual: ${formatWorkflowGraphFanoutSummary(step.fanout)}`);
		if (step.fanout.many) lines.push("diagram: fork → visible workers/lanes → join, with … when the count is large or dynamic");
	}
	if (step.kind === "fanout") lines.push("branches: one Pi subagent per item/spec", "join: results array; failed branches may be null with settle:true");
	else if (step.kind === "barrier") lines.push("branches: async thunks run concurrently", "join: barrier waits for every branch before continuing");
	else if (step.kind === "pipeline") lines.push("lanes: each item flows through stages", "join: returned array preserves item order");
	else if (step.kind === "subworkflow") {
		lines.push("delegates to another workflow and returns to this flow");
		if (step.subworkflow) lines.push(`expands: ${step.subworkflow.workflow.name} (${step.subworkflow.steps.length} steps)`);
		else if (step.subworkflowError) lines.push(`subgraph unavailable: ${step.subworkflowError}`);
	}
	else if (step.kind === "agent") lines.push("single Pi subagent call");
	else if (step.kind === "shell") lines.push("host shell command from workflow cwd");
	else if (step.kind === "artifact") lines.push("persists run evidence outside chat context");
	else lines.push("file helper inside workflow cwd");
	const childSummary = summarizeWorkflowGraphChildren(step.children);
	if (childSummary) lines.push(`inside: ${childSummary}`);
	return lines;
}

function workflowGraphStyles(theme?: any): WorkflowGraphRenderTheme {
	return {
		accent: (text: string) => theme ? theme.fg("accent", text) : text,
		muted: (text: string) => theme ? theme.fg("muted", text) : text,
		success: (text: string) => theme ? theme.fg("success", text) : text,
		warning: (text: string) => theme ? theme.fg("warning", text) : text,
	};
}

function renderWorkflowGraphSubworkflowSummaryLines(model: WorkflowGraphModel, depth = 1): string[] {
	const indent = "  ".repeat(depth);
	const lines = [`${indent}↳ sub-workflow graph: ${model.workflow.name} (${model.steps.length} steps)`];
	for (const step of model.steps.slice(0, 12)) {
		lines.push(`${indent}  ${step.symbol} ${step.label} L${step.line} ctx.${step.method}`);
		if (step.subworkflow) lines.push(...renderWorkflowGraphSubworkflowSummaryLines(step.subworkflow, depth + 2));
		else if (step.subworkflowError) lines.push(`${indent}    ↳ subgraph unavailable: ${step.subworkflowError}`);
	}
	if (model.steps.length > 12) lines.push(`${indent}  … ${model.steps.length - 12} more steps`);
	return lines;
}

function renderWorkflowGraphOverviewLines(model: WorkflowGraphModel, width: number, theme?: any): string[] {
	if (width <= 0) return [];
	const w = width;
	const style = workflowGraphStyles(theme);
	const line = (textValue: string) => truncateToWidth(textValue, w, "");
	const steps = model.steps;
	const stats = workflowGraphStats(model);
	const fanoutCount = steps.filter((step) => step.kind === "fanout" || step.kind === "barrier" || step.kind === "pipeline").length;
	const ioCount = steps.filter((step) => step.kind === "artifact" || step.kind === "file" || step.kind === "shell").length;
	const lines: string[] = [
		line(`${style.accent("Workflow topology")} ${style.muted("static preview")}`),
		line(`${style.muted("name:")} ${model.workflow.name}`),
		line(`${style.muted("file:")} ${model.workflow.relativePath}`),
		line(`${style.muted("steps:")} ${steps.length}${stats.steps !== steps.length ? ` (${stats.steps} incl. sub-workflows)` : ""} ${style.muted("• orchestration:")} ${fanoutCount} ${style.muted("• I/O:")} ${ioCount}${stats.subworkflows ? ` ${style.muted("• sub-workflows:")} ${stats.subworkflows}` : ""}`),
		line(`${style.muted("legend:")} ${style.accent("◆ fan-out ×N")} ${style.muted("|")} ${style.accent("⧉ barrier branches")} ${style.muted("|")} ${style.accent("▣ pipeline lanes")} ${style.muted("|")} ${style.accent("● agent")} ${style.muted("|")} ${style.accent("$ bash")} ${style.muted("|")} ${style.accent("▤ artifact")}`),
		line(""),
		line(style.accent("Topology")),
	];

	if (steps.length === 0) {
		lines.push(line(`  ${style.warning("No ctx.* workflow API calls detected.")}`));
		lines.push(line(`  ${style.muted("This may be a trivial workflow or the graph heuristic missed dynamic indirection.")}`));
	} else {
		lines.push(line(`  ${style.success("start")} ${style.muted("→")} ${graphTextLabel(model.workflow.name)}`));
		for (const step of steps) {
			lines.push(line(`    ${style.muted("│")}`));
			lines.push(line(`    ${style.accent(step.symbol)} ${step.label} ${style.muted(`L${step.line} ctx.${step.method}`)}`));
			for (const detail of renderWorkflowGraphStepDetail(step)) {
				lines.push(line(`    ${style.muted("│")} ${style.muted(detail)}`));
			}
			if (step.subworkflow) {
				for (const subLine of renderWorkflowGraphSubworkflowSummaryLines(step.subworkflow)) {
					lines.push(line(`    ${style.muted("│")} ${style.muted(subLine)}`));
				}
			}
		}
		lines.push(line(`    ${style.muted("│")}`));
		lines.push(line(`  ${style.success("done")}`));
	}

	lines.push(line(""));
	lines.push(line(style.accent("Detected calls")));
	if (steps.length === 0) {
		lines.push(line(style.muted("No calls to list.")));
	} else {
		for (const step of steps) {
			const index = padRightVisible(`${step.index}.`, 4);
			lines.push(line(`${style.muted(index)}${style.accent(step.symbol)} ${step.label} ${style.muted(`— L${step.line}, ctx.${step.method}`)}`));
			for (const child of step.children) {
				lines.push(line(`${style.muted("    ↳")} ${style.accent(child.symbol)} ${child.label} ${style.muted(`— L${child.line}, nested ctx.${child.method}`)}`));
			}
			if (step.subworkflow) {
				for (const subLine of renderWorkflowGraphSubworkflowSummaryLines(step.subworkflow)) lines.push(line(style.muted(`    ${subLine}`)));
			}
		}
	}

	lines.push(line(""));
	lines.push(line(style.accent("Limitations")));
	for (const note of model.notes) lines.push(line(`${style.muted("•")} ${style.muted(note)}`));
	return lines;
}

function workflowGraphSingularUnit(unit: WorkflowGraphFanoutUnit): string {
	if (unit === "agents") return "agent";
	if (unit === "branches") return "branch";
	return "lane";
}

function workflowGraphVisibleFanoutSlots(fanout: WorkflowGraphFanoutInfo): string[] {
	const unit = workflowGraphSingularUnit(fanout.unit);
	if (fanout.count !== undefined) {
		if (fanout.count <= 0) return [`no ${fanout.unit}`];
		if (fanout.count <= 6) return Array.from({ length: fanout.count }, (_, index) => `${unit} ${index + 1}`);
		return [`${unit} 1`, `${unit} 2`, `${unit} 3`, "…", `${unit} ${fanout.count}`];
	}
	return [`${unit} 1`, `${unit} 2`, "…", `${unit} n`];
}

function appendWorkflowGraphMermaidSteps(lines: string[], model: WorkflowGraphModel, previousExit: string, prefix: string, indent: string): string {
	let currentExit = previousExit;
	for (const step of model.steps) {
		const id = `${prefix}s${step.index}`;
		const label = mermaidLabel(`${step.symbol} ${step.label}`);
		if (step.kind === "subworkflow" && step.subworkflow) {
			const groupId = `${prefix}g${step.index}_sub`;
			const subStartId = `${id}_start`;
			const subDoneId = `${id}_return`;
			lines.push(`${indent}subgraph ${groupId}["${label}"]`);
			lines.push(`${indent}  direction TD`);
			lines.push(`${indent}  ${subStartId}([${mermaidLabel(step.subworkflow.workflow.name)}])`);
			const subExit = appendWorkflowGraphMermaidSteps(lines, step.subworkflow, subStartId, `${prefix}s${step.index}_`, `${indent}  `);
			lines.push(`${indent}  ${subExit} --> ${subDoneId}([return])`);
			lines.push(`${indent}end`);
			lines.push(`${indent}${currentExit} --> ${groupId}`);
			currentExit = groupId;
			continue;
		}
		if (step.fanout) {
			const groupId = `${prefix}g${step.index}`;
			const entryId = `${id}_in`;
			const exitId = `${id}_out`;
			const entryLabel = step.kind === "pipeline" ? "items" : "fork";
			const exitLabel = step.kind === "barrier" ? "barrier" : "join";
			lines.push(`${indent}subgraph ${groupId}["${label}"]`);
			lines.push(`${indent}  direction LR`);
			lines.push(`${indent}  ${entryId}((${mermaidLabel(entryLabel)}))`);
			lines.push(`${indent}  ${exitId}((${mermaidLabel(exitLabel)}))`);
			const slots = workflowGraphVisibleFanoutSlots(step.fanout);
			for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
				const workerId = `${id}_w${slotIndex + 1}`;
				const workerLabel = step.fanout.unit === "lanes" && step.fanout.stages !== undefined
					? `${slots[slotIndex]} · ${step.fanout.stages} stages`
					: slots[slotIndex]!;
				lines.push(`${indent}  ${workerId}["${mermaidLabel(workerLabel)}"]`);
				lines.push(`${indent}  ${entryId} --> ${workerId}`);
				lines.push(`${indent}  ${workerId} --> ${exitId}`);
			}
			lines.push(`${indent}end`);
			lines.push(`${indent}${currentExit} --> ${groupId}`);
			currentExit = groupId;
			continue;
		}
		const unavailable = step.kind === "subworkflow" && step.subworkflowError ? ` · ${step.subworkflowError}` : "";
		const shape = step.kind === "fanout" || step.kind === "barrier" || step.kind === "pipeline" ? `{{${label}}}` : `["${mermaidLabel(`${step.symbol} ${step.label}${unavailable}`)}"]`;
		lines.push(`${indent}${id}${shape}`);
		lines.push(`${indent}${currentExit} --> ${id}`);
		currentExit = id;
	}
	return currentExit;
}

function renderWorkflowGraphMermaidLines(model: WorkflowGraphModel): string[] {
	const lines = ["flowchart TD", `  start([${mermaidLabel(model.workflow.name)}])`];
	if (model.steps.length === 0) {
		lines.push("  start --> done([done])");
		return lines;
	}
	const exit = appendWorkflowGraphMermaidSteps(lines, model, "start", "", "  ");
	lines.push(`  ${exit} --> done([done])`);
	return lines;
}

interface WorkflowGraphImageRender {
	base64: string;
	pngPath: string;
	mmdPath: string;
	command: string;
	elapsedMs: number;
	width: number;
	height: number;
	scale: number;
}

interface WorkflowGraphImageAttempt {
	image?: WorkflowGraphImageRender;
	warning?: string;
}

interface ProcessResult {
	ok: boolean;
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	error?: string;
	timedOut?: boolean;
}

function displayPathFromCwd(cwd: string, file: string): string {
	const relative = path.relative(cwd, file).replaceAll(path.sep, "/");
	return relative && !relative.startsWith("../") && relative !== ".." && !path.isAbsolute(relative) ? relative : file;
}

function clampWorkflowGraphNumber(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function workflowGraphStats(model: WorkflowGraphModel): { steps: number; fanoutSlots: number; orchestrationGroups: number; subworkflows: number } {
	let steps = model.steps.length;
	let fanoutSlots = 0;
	let orchestrationGroups = 0;
	let subworkflows = 0;
	for (const step of model.steps) {
		if (step.fanout) {
			fanoutSlots += workflowGraphVisibleFanoutSlots(step.fanout).length;
			orchestrationGroups++;
		}
		if (step.subworkflow) {
			subworkflows++;
			const child = workflowGraphStats(step.subworkflow);
			steps += child.steps;
			fanoutSlots += child.fanoutSlots;
			orchestrationGroups += child.orchestrationGroups;
			subworkflows += child.subworkflows;
		}
	}
	return { steps, fanoutSlots, orchestrationGroups, subworkflows };
}

function workflowGraphImageOptions(model: WorkflowGraphModel): { width: number; height: number; scale: number; maxWidthCells: number; maxHeightCells: number } {
	const stats = workflowGraphStats(model);
	return {
		width: clampWorkflowGraphNumber(2200 + stats.fanoutSlots * 120 + stats.subworkflows * 220, 2200, 3800),
		height: clampWorkflowGraphNumber(1300 + stats.steps * 130 + stats.orchestrationGroups * 180 + stats.subworkflows * 220, 1300, 3200),
		scale: 2,
		maxWidthCells: 320,
		maxHeightCells: clampWorkflowGraphNumber(54 + stats.orchestrationGroups * 8 + stats.subworkflows * 8 + Math.floor(stats.steps / 2), 54, 96),
	};
}

function mmdcBinName(): string {
	return process.platform === "win32" ? "mmdc.cmd" : "mmdc";
}

function resolveMmdcInvocation(cwd: string): { command: string; argsPrefix: string[]; display: string } {
	const bin = mmdcBinName();
	const candidates = [path.join(cwd, "node_modules", ".bin", bin), path.join(process.cwd(), "node_modules", ".bin", bin), path.join(EXTENSION_ROOT, "node_modules", ".bin", bin)];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return { command: candidate, argsPrefix: [], display: displayPathFromCwd(cwd, candidate) };
	}
	return { command: "mmdc", argsPrefix: [], display: "mmdc" };
}

async function runProcess(command: string, args: string[], options: { cwd: string; timeoutMs: number }): Promise<ProcessResult> {
	return await new Promise<ProcessResult>((resolve) => {
		let stdout = "";
		let stderr = "";
		let finished = false;
		const append = (current: string, chunk: Buffer) => {
			const next = current + chunk.toString("utf8");
			return next.length > 20_000 ? next.slice(-20_000) : next;
		};
		const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
		}, options.timeoutMs);
		const finish = (result: ProcessResult) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			resolve(result);
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = append(stdout, chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = append(stderr, chunk);
		});
		child.on("error", (err) => finish({ ok: false, code: null, signal: null, stdout, stderr, error: err instanceof Error ? err.message : String(err) }));
		child.on("close", (code, signal) => finish({ ok: code === 0, code, signal, stdout, stderr, timedOut: signal === "SIGTERM" }));
	});
}

async function runStreamingAgentProcess(
	command: string,
	args: string[],
	options: {
		cwd: string;
		timeoutMs: number;
		signal: AbortSignal;
		onStdout?: (chunk: Buffer) => void | Promise<void>;
		onStderr?: (chunk: Buffer) => void | Promise<void>;
	},
): Promise<{ code: number; killed: boolean; stdout: string; stderr: string }> {
	return await new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let killed = false;
		let finished = false;
		const append = (current: string, chunk: Buffer) => {
			const next = current + chunk.toString("utf8");
			return next.length > MAX_JOURNALED_STREAM ? next.slice(-MAX_JOURNALED_STREAM) : next;
		};
		const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
		const kill = () => {
			killed = true;
			child.kill("SIGTERM");
		};
		const timer = setTimeout(kill, options.timeoutMs);
		const onAbort = () => kill();
		options.signal.addEventListener("abort", onAbort, { once: true });
		const finish = (err: Error | undefined, code = 1) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			options.signal.removeEventListener("abort", onAbort);
			if (err) reject(err);
			else resolve({ code, killed, stdout, stderr });
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = append(stdout, chunk);
			void options.onStdout?.(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = append(stderr, chunk);
			void options.onStderr?.(chunk);
		});
		child.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
		child.on("close", (code, signal) => finish(undefined, code ?? (signal ? 143 : 1)));
	});
}

function formatMmdcFailure(command: string, result: ProcessResult): string {
	const details = [result.error, result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n").trim();
	const hint = /Could not find Chrome|Chrome.*not found|browser/i.test(details)
		? "\nHint: run `npx puppeteer browsers install chrome-headless-shell` if the Puppeteer browser was not installed."
		: "";
	const code = result.code === null ? "spawn" : `exit ${result.code}`;
	return `mmdc failed (${code}) via ${command}.${hint}${details ? `\n${details}` : ""}`;
}

async function renderWorkflowGraphImage(ctx: ExtensionContext, model: WorkflowGraphModel): Promise<WorkflowGraphImageAttempt> {
	if (!getCapabilities().images) return { warning: "Terminal image protocol is not available, so inline PNG rendering is disabled." };
	const root = getGraphRoot(ctx);
	await ensureDir(root);
	const base = `${slugify(model.workflow.name)}-${crypto.createHash("sha1").update(model.workflow.path).digest("hex").slice(0, 8)}`;
	const mmdPath = path.join(root, `${base}.mmd`);
	const pngPath = path.join(root, `${base}.png`);
	await fs.writeFile(mmdPath, `${renderWorkflowGraphMermaidLines(model).join("\n")}\n`, "utf8");

	const invocation = resolveMmdcInvocation(ctx.cwd);
	const imageOptions = workflowGraphImageOptions(model);
	const args = [
		...invocation.argsPrefix,
		"-q",
		"-i",
		mmdPath,
		"-o",
		pngPath,
		"-e",
		"png",
		"-t",
		"dark",
		"-b",
		"transparent",
		"-w",
		String(imageOptions.width),
		"-H",
		String(imageOptions.height),
		"-s",
		String(imageOptions.scale),
	];
	const started = Date.now();
	const result = await runProcess(invocation.command, args, { cwd: ctx.cwd, timeoutMs: 60_000 });
	if (!result.ok) return { warning: formatMmdcFailure(invocation.display, result) };
	try {
		const base64 = await fs.readFile(pngPath, "base64");
		return { image: { base64, pngPath, mmdPath, command: invocation.display, elapsedMs: Date.now() - started, width: imageOptions.width, height: imageOptions.height, scale: imageOptions.scale } };
	} catch (err) {
		return { warning: `mmdc reported success but the PNG could not be read: ${err instanceof Error ? err.message : String(err)}` };
	}
}

function renderWorkflowGraphDocumentLines(model: WorkflowGraphModel, width: number, theme?: any): string[] {
	if (width <= 0) return [];
	const style = workflowGraphStyles(theme);
	const line = (textValue: string) => truncateToWidth(textValue, width, "");
	const lines = renderWorkflowGraphOverviewLines(model, width, theme);
	lines.push(line(""));
	lines.push(line(style.accent("Mermaid export")));
	lines.push(line(style.muted("Copyable fallback for tools/docs that can render Mermaid.")));
	lines.push(line("```mermaid"));
	for (const mermaidLine of renderWorkflowGraphMermaidLines(model)) lines.push(line(mermaidLine));
	lines.push(line("```"));
	return lines;
}

function makeWorkflowGraph(workflow: WorkflowFile, code: string): string {
	return renderWorkflowGraphDocumentLines(buildWorkflowGraphModel(workflow, code), 120).join("\n");
}

async function makeWorkflowGraphForContext(ctx: ExtensionContext, workflow: WorkflowFile, code: string): Promise<string> {
	return renderWorkflowGraphDocumentLines(await buildWorkflowGraphModelWithSubworkflows(ctx, workflow, code), 120).join("\n");
}

class WorkflowGraphComponent {
	private cachedWidth?: number;
	private cachedLines?: string[];
	private readonly imageComponent?: TerminalImage;

	constructor(
		private readonly model: WorkflowGraphModel,
		private readonly theme: any,
		private readonly close: () => void,
		private readonly imageAttempt: WorkflowGraphImageAttempt = {},
	) {
		if (imageAttempt.image) {
			const imageOptions = workflowGraphImageOptions(model);
			this.imageComponent = new TerminalImage(imageAttempt.image.base64, "image/png", { fallbackColor: (textValue: string) => theme.fg("muted", textValue) }, { filename: path.basename(imageAttempt.image.pngPath), maxWidthCells: imageOptions.maxWidthCells, maxHeightCells: imageOptions.maxHeightCells });
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || data === "q") this.close();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const w = Math.max(1, width);
		const line = (textValue: string) => truncateToWidth(textValue, w, "");
		const help = line(this.theme.fg("dim", "enter/q/esc close • mmdc PNG when supported • static graph; use /workflow view for runtime timeline"));
		const lines = [help];
		if (this.imageAttempt.image && this.imageComponent) {
			const image = this.imageAttempt.image;
			lines.push(line(`${this.theme.fg("accent", "Mermaid PNG")} ${this.theme.fg("dim", `via ${image.command} • ${image.width}×${image.height} @${image.scale}x • ${image.elapsedMs}ms`)}`));
			lines.push(line(this.theme.fg("dim", `png: ${image.pngPath}`)));
			lines.push(line(this.theme.fg("dim", `mmd: ${image.mmdPath}`)));
			lines.push(...this.imageComponent.render(w));
			lines.push(line(""));
		} else if (this.imageAttempt.warning) {
			lines.push(line(this.theme.fg("warning", "Mermaid PNG unavailable; falling back to text graph.")));
			for (const warningLine of this.imageAttempt.warning.split(/\r?\n/).slice(0, 8)) lines.push(line(this.theme.fg("muted", warningLine)));
			lines.push(line(""));
		}
		lines.push(...renderWorkflowGraphDocumentLines(this.model, w, this.theme));
		this.cachedLines = lines;
		this.cachedWidth = width;
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

async function showWorkflowGraph(ctx: ExtensionContext, workflow: WorkflowFile, code: string): Promise<void> {
	const model = await buildWorkflowGraphModelWithSubworkflows(ctx, workflow, code);
	if (ctx.mode === "print") {
		console.log(renderWorkflowGraphDocumentLines(model, 120).join("\n"));
		return;
	}
	if (ctx.mode === "tui") {
		const imageAttempt = await renderWorkflowGraphImage(ctx, model).catch((err) => ({ warning: err instanceof Error ? err.message : String(err) }));
		await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => new WorkflowGraphComponent(model, theme, () => done(undefined), imageAttempt));
		return;
	}
	if (ctx.hasUI) {
		await ctx.ui.editor(`Workflow graph: ${workflow.name}`, renderWorkflowGraphDocumentLines(model, 120).join("\n"));
		return;
	}
	notify(ctx, renderWorkflowGraphDocumentLines(model, 100).join("\n"), "info");
}

async function getRunDirs(ctx: ExtensionContext): Promise<string[]> {
	const dirs: Array<{ full: string; mtimeMs: number }> = [];
	for (const root of getRunRoots(ctx)) {
		if (!existsSync(root)) continue;
		const entries = await fs.readdir(root, { withFileTypes: true });
		dirs.push(...await Promise.all(
			entries
				.filter((entry) => entry.isDirectory())
				.map(async (entry) => {
					const full = path.join(root, entry.name);
					const stat = await fs.stat(full);
					return { full, mtimeMs: stat.mtimeMs };
				}),
		));
	}
	return dirs.sort((a, b) => b.mtimeMs - a.mtimeMs).map((entry) => entry.full);
}

async function writeJsonFile(file: string, value: unknown): Promise<void> {
	// Atomic write: write to a unique temp file then rename, so a crash mid-write
	// never leaves a truncated/corrupt status.json or result.json behind.
	const temp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
	await fs.writeFile(temp, `${safeJson(value)}\n`, "utf8");
	try {
		await fs.rename(temp, file);
	} catch (err) {
		await fs.rm(temp, { force: true }).catch(() => {});
		throw err;
	}
}

async function writeRunStatus(status: WorkflowRunStatus): Promise<void> {
	await writeJsonFile(path.join(status.runDir, "status.json"), status);
}

// --- Resumable runs: content-address cache journal ---

// Deterministic JSON: object keys sorted recursively so identical args always
// produce the same string regardless of key insertion order. undefined values
// are dropped (mirroring JSON.stringify); arrays keep their order.
function stableStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	const encode = (current: unknown): string => {
		if (current === null) return "null";
		const t = typeof current;
		if (t === "number") return Number.isFinite(current as number) ? String(current) : "null";
		if (t === "boolean") return String(current);
		if (t === "bigint") return JSON.stringify((current as bigint).toString());
		if (t === "string") return JSON.stringify(current);
		if (t === "undefined" || t === "function" || t === "symbol") return "null";
		if (Array.isArray(current)) {
			if (seen.has(current)) return '"[Circular]"';
			seen.add(current);
			const out = `[${current.map((item) => encode(item)).join(",")}]`;
			seen.delete(current);
			return out;
		}
		const obj = current as Record<string, unknown>;
		if (seen.has(obj)) return '"[Circular]"';
		seen.add(obj);
		const keys = Object.keys(obj).filter((key) => {
			const v = obj[key];
			return v !== undefined && typeof v !== "function" && typeof v !== "symbol";
		}).sort();
		const out = `{${keys.map((key) => `${JSON.stringify(key)}:${encode(obj[key])}`).join(",")}}`;
		seen.delete(obj);
		return out;
	};
	return encode(value);
}

function computeCallKey(method: string, args: unknown): string {
	return crypto.createHash("sha256").update(`${method}\n${stableStringify(args)}`).digest("hex");
}

function computeCodeHash(code: string): string {
	return crypto.createHash("sha256").update(transformWorkflowCode(code)).digest("hex");
}

// Parse journal.jsonl into a key -> array(occ) map (last-wins per (key, occ)).
// Tolerant of a torn final line (same convention as readRunLogEvents): the last
// line is discarded if it does not parse, since a crash can truncate it.
async function loadJournal(runDir: string): Promise<JournalCache> {
	const cache: JournalCache = new Map();
	let body: string;
	try {
		body = await fs.readFile(path.join(runDir, JOURNAL_FILE), "utf8");
	} catch {
		return cache;
	}
	const journalPath = path.join(runDir, JOURNAL_FILE);
	const lines = body.split("\n");
	let lastContentLine = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i]!.trim()) {
			lastContentLine = i;
			break;
		}
	}
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (!line.trim()) continue;
		let record: JournalRecord;
		try {
			record = JSON.parse(line) as JournalRecord;
		} catch {
			// A crash can leave the final JSONL record torn; tolerate only that case.
			if (i === lastContentLine) continue;
			console.warn(`[dynamic-workflows] Ignoring malformed journal line ${i + 1} in ${journalPath}; resume cache may be incomplete.`);
			continue;
		}
		if (!record || typeof record.key !== "string" || typeof record.occ !== "number" || !record.result) continue;
		const slots = cache.get(record.key) ?? [];
		slots[record.occ] = record.result; // last-wins for a repeated (key, occ)
		cache.set(record.key, slots);
	}
	return cache;
}

async function appendJournalRecord(runDir: string, record: JournalRecord): Promise<void> {
	await appendJsonLine(path.join(runDir, JOURNAL_FILE), record);
}

function normalizeSubagentResultForJournal(result: SubagentResult): SubagentResult {
	return {
		...result,
		output: truncate(result.output, MAX_AGENT_OUTPUT_IN_RESULT),
		stdout: truncate(result.stdout, MAX_JOURNALED_STREAM),
		stderr: truncate(result.stderr, MAX_JOURNALED_STREAM),
	};
}

function normalizeBashResultForJournal(result: BashResult): BashResult {
	return {
		...result,
		stdout: truncate(result.stdout, MAX_JOURNALED_STREAM),
		stderr: truncate(result.stderr, MAX_JOURNALED_STREAM),
	};
}

// Highest agent id recorded in the journal. A count is NOT safe here: the
// journal can be non-contiguous (gaps from in-flight/{cache:false} agents that
// never journaled, or out-of-order completion under concurrency), so resumed
// runs must start agentCount strictly above the max existing id, never the
// count, or a fresh agents/NNNN would clobber a cached artifact on disk.
function maxJournalAgentId(cache: JournalCache): number {
	let max = 0;
	for (const slots of cache.values()) {
		for (const result of slots) {
			if (result && "artifactPath" in result && typeof result.id === "number" && result.id > max) {
				max = result.id;
			}
		}
	}
	return max;
}

// Highest NNNN prefix among agents/NNNN-*.md artifacts already on disk. This
// covers ids that were never journaled (e.g. {cache:false} agents from the
// original run), so resumed agentCount also clears those and never overwrites
// any existing artifact.
async function maxAgentArtifactNumber(runDir: string): Promise<number> {
	let max = 0;
	let names: string[];
	try {
		names = await fs.readdir(path.join(runDir, "agents"));
	} catch {
		return 0;
	}
	for (const name of names) {
		const m = /^(\d{4})-/.exec(name);
		if (m) {
			const n = Number.parseInt(m[1]!, 10);
			if (Number.isFinite(n) && n > max) max = n;
		}
	}
	return max;
}

async function readRunResult(runDir: string): Promise<WorkflowRunResult | undefined> {
	try {
		return JSON.parse(await fs.readFile(path.join(runDir, "result.json"), "utf8")) as WorkflowRunResult;
	} catch {
		return undefined;
	}
}

async function readRunStatus(runDir: string): Promise<WorkflowRunStatus | undefined> {
	try {
		const status = JSON.parse(await fs.readFile(path.join(runDir, "status.json"), "utf8")) as WorkflowRunStatus;
		if (status.state === "running" && !activeRuns.has(status.runId)) {
			const now = Date.now();
			const started = new Date(status.startedAt).getTime();
			return {
				...status,
				state: "stale",
				active: false,
				updatedAt: new Date(now).toISOString(),
				elapsedMs: Number.isFinite(started) ? now - started : status.elapsedMs,
			};
		}
		return { ...status, active: status.state === "running" && activeRuns.has(status.runId) };
	} catch {
		return undefined;
	}
}

async function readRunRecord(runDir: string): Promise<WorkflowRunRecord | undefined> {
	const result = await readRunResult(runDir);
	if (result) return result;
	return await readRunStatus(runDir);
}

function isRunResult(run: WorkflowRunRecord): run is WorkflowRunResult {
	return "ok" in run;
}

function getRunState(run: WorkflowRunRecord): WorkflowRunState {
	if (!isRunResult(run)) return run.state;
	if (run.state) return run.state;
	if (run.ok) return "completed";
	return run.error?.toLowerCase().includes("cancel") ? "cancelled" : "failed";
}

function getRunLogs(run: WorkflowRunRecord): WorkflowLogEntry[] {
	return run.logs ?? [];
}

// A run can be resumed in place when it was interrupted (stale) or ended
// without completing (failed/cancelled). Completed runs need force.
function isResumableState(state: WorkflowRunState): boolean {
	return state === "stale" || state === "failed" || state === "cancelled";
}

function getRunCachedCalls(run: WorkflowRunRecord): number {
	return typeof run.cachedCalls === "number" ? run.cachedCalls : 0;
}

function getRunStatusLabel(run: WorkflowRunRecord): string {
	const state = getRunState(run);
	if (state === "completed") return "completed";
	if (state === "running") return "running";
	if (state === "cancelled") return "cancelled";
	if (state === "stale") return "stale";
	return "failed";
}

function getRunStatusIcon(run: WorkflowRunRecord): string {
	const state = getRunState(run);
	if (state === "completed") return "✓";
	if (state === "running") return "▶";
	if (state === "cancelled") return "■";
	if (state === "stale") return "?";
	return "✗";
}

interface ParsedRunEvents {
	logs: WorkflowLogEntry[];
	agents: AgentMonitorModel[];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function phaseEventFields(phase: AgentPhaseInfo | undefined): Partial<SubagentResult> {
	if (!phase || phase.total <= 0) return {};
	return {
		phaseId: phase.id,
		phaseIndex: phase.index,
		phaseTotal: phase.total,
		...(phase.label ? { phaseLabel: phase.label } : {}),
	};
}

function formatAgentPhase(agent: Pick<AgentMonitorModel, "phaseId" | "phaseIndex" | "phaseTotal" | "phaseLabel">): string | undefined {
	if (!agent.phaseIndex || !agent.phaseTotal) return undefined;
	const batch = agent.phaseId ? `P${agent.phaseId} ` : "";
	return `${batch}${agent.phaseIndex}/${agent.phaseTotal}`;
}

function stringArrayValue(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const values = value.filter((item): item is string => typeof item === "string");
	return values.length === value.length ? values : undefined;
}

function isAgentMonitorState(value: unknown): value is AgentMonitorState {
	return value === "running" || value === "completed" || value === "failed" || value === "cached" || value === "unknown";
}

function mergeAgentMonitor(existing: AgentMonitorModel | undefined, patch: Partial<AgentMonitorModel> & { id: number; name: string }): AgentMonitorModel {
	const existingState = existing?.state;
	const patchState = patch.state;
	const state = existingState && (existingState === "completed" || existingState === "failed" || existingState === "cached") && patchState === "running"
		? existingState
		: patchState ?? existingState ?? "unknown";
	const artifactPath = patch.artifactPath ?? existing?.artifactPath;
	return {
		id: patch.id,
		name: patch.name || existing?.name || `agent-${patch.id}`,
		state,
		...(existing?.startedAt || patch.startedAt ? { startedAt: patch.startedAt ?? existing?.startedAt } : {}),
		...(existing?.endedAt || patch.endedAt ? { endedAt: patch.endedAt ?? existing?.endedAt } : {}),
		...(existing?.elapsedMs !== undefined || patch.elapsedMs !== undefined ? { elapsedMs: patch.elapsedMs ?? existing?.elapsedMs } : {}),
		...(existing?.ok !== undefined || patch.ok !== undefined ? { ok: patch.ok ?? existing?.ok } : {}),
		...(existing?.code !== undefined || patch.code !== undefined ? { code: patch.code ?? existing?.code } : {}),
		...(existing?.killed !== undefined || patch.killed !== undefined ? { killed: patch.killed ?? existing?.killed } : {}),
		...(artifactPath ? { artifactPath } : {}),
		...(existing?.tools || patch.tools ? { tools: patch.tools ?? existing?.tools } : {}),
		...(existing?.excludeTools || patch.excludeTools ? { excludeTools: patch.excludeTools ?? existing?.excludeTools } : {}),
		...(existing?.skills || patch.skills ? { skills: patch.skills ?? existing?.skills } : {}),
		...(existing?.includeSkills !== undefined || patch.includeSkills !== undefined ? { includeSkills: patch.includeSkills ?? existing?.includeSkills } : {}),
		...(existing?.extensions || patch.extensions ? { extensions: patch.extensions ?? existing?.extensions } : {}),
		...(existing?.includeExtensions !== undefined || patch.includeExtensions !== undefined ? { includeExtensions: patch.includeExtensions ?? existing?.includeExtensions } : {}),
		...(existing?.keys || patch.keys ? { keys: patch.keys ?? existing?.keys } : {}),
		...(existing?.missingKeys || patch.missingKeys ? { missingKeys: patch.missingKeys ?? existing?.missingKeys } : {}),
		...(existing?.isolatedEnv !== undefined || patch.isolatedEnv !== undefined ? { isolatedEnv: patch.isolatedEnv ?? existing?.isolatedEnv } : {}),
		...(existing?.phaseId !== undefined || patch.phaseId !== undefined ? { phaseId: patch.phaseId ?? existing?.phaseId } : {}),
		...(existing?.phaseIndex !== undefined || patch.phaseIndex !== undefined ? { phaseIndex: patch.phaseIndex ?? existing?.phaseIndex } : {}),
		...(existing?.phaseTotal !== undefined || patch.phaseTotal !== undefined ? { phaseTotal: patch.phaseTotal ?? existing?.phaseTotal } : {}),
		...(existing?.phaseLabel || patch.phaseLabel ? { phaseLabel: patch.phaseLabel ?? existing?.phaseLabel } : {}),
		...(existing?.promptPreview || patch.promptPreview ? { promptPreview: patch.promptPreview ?? existing?.promptPreview } : {}),
		...(existing?.output || patch.output ? { output: patch.output ?? existing?.output } : {}),
		...(existing?.schemaOk !== undefined || patch.schemaOk !== undefined ? { schemaOk: patch.schemaOk ?? existing?.schemaOk } : {}),
		promptAvailable: existing?.promptAvailable === true || patch.promptAvailable === true || !!artifactPath,
	};
}

async function readFilePrefix(file: string, maxBytes = 16_000): Promise<string> {
	const handle = await fs.open(file, "r");
	try {
		const buffer = Buffer.alloc(maxBytes);
		const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}
}

async function readRunEvents(runDir: string): Promise<ParsedRunEvents> {
	const logs: WorkflowLogEntry[] = [];
	const agentsById = new Map<number, AgentMonitorModel>();
	const upsert = (patch: Partial<AgentMonitorModel> & { id: number; name: string }) => {
		agentsById.set(patch.id, mergeAgentMonitor(agentsById.get(patch.id), patch));
	};

	try {
		const body = await fs.readFile(path.join(runDir, "events.jsonl"), "utf8");
		for (const line of body.split("\n")) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line) as { type?: string; time?: string; message?: string; details?: unknown; [key: string]: unknown };
				if (event.type === "log" && event.time && event.message) {
					const logEntry: WorkflowLogEntry = { time: event.time, message: event.message, ...(event.details === undefined ? {} : { details: event.details }) };
					logs.push(logEntry);
					const startMatch = /^agent (\d+) start: (.+)$/.exec(event.message);
					if (startMatch) {
						upsert({ id: Number.parseInt(startMatch[1]!, 10), name: startMatch[2]!, state: "running", startedAt: event.time });
						continue;
					}
					const endMatch = /^agent (\d+) end: (.+)$/.exec(event.message);
					if (endMatch) {
						const details = recordValue(event.details);
						const ok = booleanValue(details?.ok);
						upsert({
							id: Number.parseInt(endMatch[1]!, 10),
							name: endMatch[2]!,
							state: ok === false ? "failed" : "completed",
							endedAt: event.time,
							...(ok === undefined ? {} : { ok }),
							...(numberValue(details?.code) === undefined ? {} : { code: numberValue(details?.code) }),
							...(numberValue(details?.elapsedMs) === undefined ? {} : { elapsedMs: numberValue(details?.elapsedMs) }),
							...(booleanValue(details?.schemaOk) === undefined ? {} : { schemaOk: booleanValue(details?.schemaOk) }),
						});
					}
				} else if (event.type === "agent") {
					const id = numberValue(event.id);
					const name = stringValue(event.name);
					if (id !== undefined && name) {
						const ok = booleanValue(event.ok);
						const explicitState = isAgentMonitorState(event.state) ? event.state : undefined;
						const tools = stringArrayValue(event.tools);
						const excludeTools = stringArrayValue(event.excludeTools);
						const skills = stringArrayValue(event.skills);
						const extensions = stringArrayValue(event.extensions);
						const keys = stringArrayValue(event.keys);
						const missingKeys = stringArrayValue(event.missingKeys);
						const phaseId = numberValue(event.phaseId);
						const phaseIndex = numberValue(event.phaseIndex);
						const phaseTotal = numberValue(event.phaseTotal);
						const phaseLabel = stringValue(event.phaseLabel);
						upsert({
							id,
							name,
							state: explicitState ?? (ok === undefined ? "unknown" : ok ? "completed" : "failed"),
							...(stringValue(event.startedAt) ? { startedAt: stringValue(event.startedAt) } : {}),
							...(stringValue(event.endedAt) ? { endedAt: stringValue(event.endedAt) } : {}),
							...(numberValue(event.elapsedMs) === undefined ? {} : { elapsedMs: numberValue(event.elapsedMs) }),
							...(ok === undefined ? {} : { ok }),
							...(numberValue(event.code) === undefined ? {} : { code: numberValue(event.code) }),
							...(booleanValue(event.killed) === undefined ? {} : { killed: booleanValue(event.killed) }),
							...(stringValue(event.artifactPath) ? { artifactPath: stringValue(event.artifactPath) } : {}),
							...(tools ? { tools } : {}),
							...(excludeTools ? { excludeTools } : {}),
							...(skills ? { skills } : {}),
							...(booleanValue(event.includeSkills) === undefined ? {} : { includeSkills: booleanValue(event.includeSkills) }),
							...(extensions ? { extensions } : {}),
							...(booleanValue(event.includeExtensions) === undefined ? {} : { includeExtensions: booleanValue(event.includeExtensions) }),
							...(keys ? { keys } : {}),
							...(missingKeys ? { missingKeys } : {}),
							...(booleanValue(event.isolatedEnv) === undefined ? {} : { isolatedEnv: booleanValue(event.isolatedEnv) }),
							...(phaseId === undefined ? {} : { phaseId }),
							...(phaseIndex === undefined ? {} : { phaseIndex }),
							...(phaseTotal === undefined ? {} : { phaseTotal }),
							...(phaseLabel ? { phaseLabel } : {}),
							...(stringValue(event.output) ? { output: stringValue(event.output) } : {}),
							...(booleanValue(event.schemaOk) === undefined ? {} : { schemaOk: booleanValue(event.schemaOk) }),
							promptAvailable: booleanValue(event.promptAvailable) === true || !!stringValue(event.artifactPath),
						});
					}
				}
			} catch {
				// Ignore malformed event lines.
			}
		}
	} catch {
		// Missing events.jsonl is tolerated for older or partial runs.
	}

	try {
		const agentDir = path.join(runDir, "agents");
		const entries = await fs.readdir(agentDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			const match = /^(\d{4})-(.+)\.md$/.exec(entry.name);
			if (!match) continue;
			const id = Number.parseInt(match[1]!, 10);
			const file = path.join(agentDir, entry.name);
			let title = match[2]!.replace(/-/g, " ");
			let promptAvailable = true;
			let promptPreview: string | undefined;
			try {
				const prefix = await readFilePrefix(file);
				const heading = /^#\s+(.+)$/m.exec(prefix);
				if (heading?.[1]) title = heading[1].trim();
				promptAvailable = /\n## Prompt\n/.test(prefix) || prefix.includes("state: running");
				const promptSection = extractMarkdownSection(prefix, "Prompt");
				if (promptSection) promptPreview = renderSafeInline(promptSection).slice(0, 500);
			} catch {
				promptAvailable = false;
			}
			upsert({ id, name: title, artifactPath: file, promptAvailable, ...(promptPreview ? { promptPreview } : {}) });
		}
	} catch {
		// Runs without agent artifacts still render their timeline normally.
	}

	return { logs, agents: [...agentsById.values()].sort((a, b) => a.id - b.id) };
}

async function readRunLogEvents(runDir: string): Promise<WorkflowLogEntry[]> {
	return (await readRunEvents(runDir)).logs;
}

async function listRuns(ctx: ExtensionContext): Promise<WorkflowRunRecord[]> {
	const runs: WorkflowRunRecord[] = [];
	for (const runDir of await getRunDirs(ctx)) {
		const record = await readRunRecord(runDir);
		if (record) runs.push(record);
	}
	return runs;
}

function formatRunList(runs: WorkflowRunRecord[]): string {
	if (runs.length === 0) return "No workflow runs found.";
	return runs
		.slice(0, 50)
		.map((run) => {
			const bg = run.background ? " bg" : "";
			const state = getRunState(run);
			const active = state === "running" ? " active" : "";
			const resumable = isResumableState(state) ? " resumable" : "";
			const cached = getRunCachedCalls(run) > 0 ? ` cached:${getRunCachedCalls(run)}` : "";
			const parallelCompact = formatParallelAgentsCompact(run);
			const parallel = parallelCompact === "-" ? "" : ` parallel:${parallelCompact}`;
			return `${getRunStatusIcon(run)} ${run.runId} — ${run.workflow}${bg} — ${getRunStatusLabel(run)}${active}${resumable} — ${Math.round(run.elapsedMs / 1000)}s — agents ${run.agentCount}${parallel}${cached}`;
		})
		.join("\n");
}

async function resolveRun(ctx: ExtensionContext, id: string | undefined): Promise<WorkflowRunRecord> {
	const runs = await listRuns(ctx);
	if (runs.length === 0) throw new Error("No workflow runs found.");
	const key = id?.trim() || "latest";
	if (key === "latest") return runs[0]!;
	const found = runs.find((run) => run.runId === key || run.runId.includes(key) || run.workflow === key);
	if (!found) throw new Error(`Workflow run not found: ${key}`);
	return found;
}

async function listRunFiles(runDir: string, maxFiles = 80): Promise<string[]> {
	const out: string[] = [];
	async function walk(dir: string): Promise<void> {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			if (out.length >= maxFiles) return;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (entry.isFile()) out.push(path.relative(runDir, full).replaceAll(path.sep, "/"));
		}
	}
	await walk(runDir);
	return out;
}

async function formatRunView(run: WorkflowRunRecord): Promise<string> {
	const files = await listRunFiles(run.runDir);
	const parsedEvents = await readRunEvents(run.runDir);
	const started = new Date(run.startedAt).getTime();
	const logs = getRunLogs(run).length > 0 ? getRunLogs(run) : parsedEvents.logs;
	const agents = parsedEvents.agents;
	const timeline = logs.map((entry) => {
		const elapsed = Math.max(0, new Date(entry.time).getTime() - started);
		const seconds = (elapsed / 1000).toFixed(1).padStart(5, " ");
		return `+${seconds}s ${entry.message}${entry.details === undefined ? "" : ` — ${stringify(entry.details, 500)}`}`;
	});
	const state = getRunState(run);
	const statusEmoji = state === "completed" ? "✅" : state === "running" ? "▶️" : state === "cancelled" ? "🟨" : state === "stale" ? "⚠️" : "❌";
	const cachedCalls = getRunCachedCalls(run);
	const resumable = isResumableState(state);
	const agentLines = agents.map((agent) => {
		const elapsed = agent.elapsedMs === undefined ? "elapsed:?" : `elapsed:${formatElapsedMs(agent.elapsedMs)}`;
		const phase = formatAgentPhase(agent);
		const code = agent.code === undefined ? "" : ` code:${agent.code}`;
		const schema = agent.schemaOk === undefined ? "" : ` schema:${agent.schemaOk ? "ok" : "bad"}`;
		const prompt = agent.promptAvailable ? " prompt:yes" : " prompt:no";
		const tools = ` tools:${agent.tools?.length ? agent.tools.join(",") : "default"}`;
		const skills = ` skills:${agent.skills?.length ? agent.skills.join(",") : agent.includeSkills === false ? "disabled" : "default"}`;
		const extensions = ` extensions:${agent.extensions?.length ? agent.extensions.join(",") : agent.includeExtensions ? "default" : "disabled"}`;
		const keys = ` keys:${agent.keys?.length ? agent.keys.join(",") : agent.isolatedEnv ? "none" : "default"}${agent.missingKeys?.length ? ` missing:${agent.missingKeys.join(",")}` : ""}`;
		const preview = agent.promptPreview ? ` — prompt preview: ${compactInline(agent.promptPreview, 180)}` : "";
		return `- #${agent.id}${phase ? ` ${phase}` : ""} ${agent.name} — ${agent.state} ${elapsed}${code}${schema}${prompt}${tools}${skills}${extensions}${keys}${agent.artifactPath ? ` — ${agent.artifactPath}` : ""}${preview}`;
	});

	// Detect whether the workflow source changed since this run (best-effort:
	// reads the recorded file path and compares hashes).
	let codeChanged = false;
	if (run.codeHash && run.file) {
		try {
			const currentCode = await fs.readFile(run.file, "utf8");
			codeChanged = computeCodeHash(currentCode) !== run.codeHash;
		} catch {
			codeChanged = false;
		}
	}

	return [
		`# Workflow run: ${run.workflow}`,
		"",
		`Status: ${statusEmoji} ${getRunStatusLabel(run)}`,
		`Run: ${run.runId}`,
		`Background: ${run.background ? "yes" : "no"}`,
		`Elapsed: ${Math.round(run.elapsedMs / 1000)}s`,
		`Agents: ${run.agentCount}`,
		`Parallel agents: ${formatParallelAgents(run, agents)}`,
		...(run.maxAgents === undefined ? [] : [`Max agents: ${run.maxAgents}`]),
		...(cachedCalls > 0 ? [`Cached calls: ${cachedCalls}`] : []),
		...(run.resumedFrom ? [`Resumed from: ${run.resumedFrom}`] : []),
		...(run.codeHash ? [`Code hash: ${run.codeHash.slice(0, 16)}`] : []),
		`Directory: ${run.runDir}`,
		...(state === "running" ? [`Cancel: /workflow cancel ${run.runId}`] : []),
		...(resumable ? [`Resume: /workflow resume ${run.runId}`] : []),
		...(state === "stale" ? ["Note: this run was marked running on disk but is not active in this Pi session."] : []),
		...(codeChanged ? ["Warning: workflow code changed since this run. On resume, calls whose arguments changed will be re-executed (cache miss); unchanged calls stay cached."] : []),
		...(run.error ? [`Error: ${run.error}`] : []),
		"",
		"## Agents",
		"",
		...(agentLines.length ? agentLines : ["No agents recorded for this run."]),
		"",
		"## Timeline",
		"",
		...(timeline.length ? timeline : ["No logs recorded."]),
		"",
		"## Files / artifacts",
		"",
		...(files.length ? files.map((file) => `- ${file}`) : ["No files found."]),
		...(isRunResult(run) && run.output !== undefined
			? ["", "## Output", "", stringify(run.output, MAX_TOOL_TEXT)]
			: state === "running"
				? ["", "## Output", "", "Output not available until completion."]
				: []),
	].join("\n");
}

function resolveAgentArtifactPath(run: WorkflowRunRecord, agent: AgentMonitorModel): string | undefined {
	if (!agent.artifactPath) return undefined;
	return path.isAbsolute(agent.artifactPath) ? agent.artifactPath : path.join(run.runDir, agent.artifactPath);
}

function resolveAgentLiveStreamPath(artifactPath: string | undefined, stream: "stdout" | "stderr"): string | undefined {
	if (!artifactPath) return undefined;
	return artifactPath.endsWith(".md") ? artifactPath.slice(0, -3) + `.${stream}.log` : `${artifactPath}.${stream}.log`;
}

function extractMarkdownSection(markdown: string, heading: string): string | undefined {
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const knownHeadings = ["Access", "Prompt", "Structured Output", "Stdout", "Stderr"];
	const nextHeadings = knownHeadings.filter((candidate) => candidate !== heading).map((candidate) => candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
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
	const parsedStdout = stdout ? parsePiJsonModeOutput(stdout) : liveStdout ? parsePiJsonModeOutputLenient(liveStdout) : undefined;
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
	const stateIcon = agent.state === "completed" ? "✅" : agent.state === "running" ? "▶️" : agent.state === "cached" ? "♻️" : agent.state === "failed" ? "❌" : "?";
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
		...(agent.isolatedEnv === undefined ? [] : [`- env: ${agent.isolatedEnv ? "isolated + selected keys" : "process default/inherited"}`]),
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
		...(structuredOutput ? ["", "## Structured output", "", fencedBlock(truncate(structuredOutput, MAX_TOOL_TEXT), "text")] : []),
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
		...(stderr || liveStderr ? ["", "### stderr", "", fencedBlock(truncate(stderr || liveStderr, 6000), "text")] : []),
	].join("\n");
}

class AgentLiveViewComponent {
	private lines: string[] = ["Loading agent execution…"];
	private scroll = 0;

	constructor(
		private readonly theme: any,
		private readonly getHeight: () => number,
		private readonly close: () => void,
	) {}

	setContent(content: string): void {
		this.lines = content.split(/\r?\n/);
		this.scroll = Math.max(0, Math.min(this.scroll, this.maxScroll()));
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.close();
			return;
		}
		if (matchesKey(data, Key.up)) this.scroll = Math.max(0, this.scroll - 1);
		else if (matchesKey(data, Key.down)) this.scroll = Math.min(this.maxScroll(), this.scroll + 1);
		else if (matchesKey(data, Key.pageUp)) this.scroll = Math.max(0, this.scroll - this.pageSize());
		else if (matchesKey(data, Key.pageDown)) this.scroll = Math.min(this.maxScroll(), this.scroll + this.pageSize());
		else if (matchesKey(data, Key.home)) this.scroll = 0;
		else if (matchesKey(data, Key.end)) this.scroll = this.maxScroll();
	}

	render(width: number): string[] {
		const w = Math.max(1, width);
		const page = this.pageSize();
		this.scroll = Math.max(0, Math.min(this.scroll, this.maxScroll()));
		const line = (textValue: string) => truncateToWidth(textValue, w, "");
		const header = this.theme.fg("accent", "Live workflow agent") + this.theme.fg("dim", ` • refresh 1s • ↑↓/PgUp/PgDn scroll • q/esc close • ${this.scroll + 1}-${Math.min(this.lines.length, this.scroll + page)}/${this.lines.length}`);
		return [
			line(header),
			line(this.theme.fg("dim", "─".repeat(Math.min(w, 120)))),
			...this.lines.slice(this.scroll, this.scroll + page).map(line),
		];
	}

	invalidate(): void {}

	private pageSize(): number {
		return Math.max(5, this.getHeight() - 4);
	}

	private maxScroll(): number {
		return Math.max(0, this.lines.length - this.pageSize());
	}
}

async function latestAgentForRun(run: WorkflowRunRecord, agent: AgentMonitorModel): Promise<AgentMonitorModel> {
	const { agents } = await readRunEvents(run.runDir);
	return agents.find((candidate) => candidate.id === agent.id) ?? agent;
}

async function showLiveAgentView(ctx: ExtensionContext, run: WorkflowRunRecord, agent: AgentMonitorModel): Promise<void> {
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
				component = new AgentLiveViewComponent(theme, () => tui.terminal.rows, () => done(undefined));
				const refresh = async () => {
					if (refreshing || !component) return;
					refreshing = true;
					try {
						const latest = await latestAgentForRun(run, agent);
						component.setContent(await formatAgentView(run, latest));
						tui.requestRender();
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
		await ctx.ui.editor(`Workflow agent: ${agent.name}`, await formatAgentView(run, await latestAgentForRun(run, agent)));
		return;
	}
	notify(ctx, await formatAgentView(run, await latestAgentForRun(run, agent)), "info");
}

type AgentMonitorState = "running" | "completed" | "failed" | "cached" | "unknown";

interface AgentMonitorModel {
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

interface WorkflowDashboardResult {
	type: "agent" | "graph" | "run" | "view" | "cancel" | "rerun" | "deleteWorkflow" | "deleteRun" | "newPattern" | "switchSession";
	workflow?: WorkflowFile;
	run?: WorkflowRunRecord;
	agent?: AgentMonitorModel;
	pattern?: WorkflowPattern;
	session?: PiSessionModel;
}

interface WorkflowAgentEntry {
	run: WorkflowRunRecord;
	agent: AgentMonitorModel;
}

interface WorkflowActivityEntry {
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

interface PiSessionModel extends PiSessionRecord {
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

function sessionManagerMetadata(ctx: ExtensionContext): { sessionId?: string; sessionFile?: string; sessionName?: string } {
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
	if (typeof record.id !== "string" || typeof record.cwd !== "string" || typeof record.mode !== "string") return undefined;
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
		...(typeof record.activeWorkflowRuns === "number" && Number.isFinite(record.activeWorkflowRuns) ? { activeWorkflowRuns: record.activeWorkflowRuns } : {}),
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
			if (!record || record.cwd !== ctx.cwd || !isPersistentPiSessionMode(record.mode)) continue;
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
		lines.push(`- ${status} ${session.mode} pid:${session.pid}${session.current ? " this" : ""}${session.sessionName ? ` name:${session.sessionName}` : ""} updated:${age} idle:${session.idle === undefined ? "unknown" : session.idle ? "yes" : "no"} workflows:${session.activeWorkflowRuns ?? 0}`);
		lines.push(`  session: ${session.sessionId ?? "unknown"}`);
		if (session.sessionFile) lines.push(`  file: ${session.sessionFile}`);
	}
	return lines.join("\n");
}

async function collectWorkflowActivity(runs: WorkflowRunRecord[], maxRuns = 12, maxEntries = 80): Promise<WorkflowActivityEntry[]> {
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

function compactInline(value: unknown, maxChars = 160): string {
	return stringify(value, maxChars).replace(/\s+/g, " ").trim();
}

interface WorkflowMonitorModel {
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
		const bookkeeping = new Set(["status.json", "result.json", "input.json", "events.jsonl", JOURNAL_FILE, "summary.md"]);
		return files.filter((file) => !bookkeeping.has(file)).length;
	} catch {
		return 0;
	}
}

function canRerunRun(run: WorkflowRunRecord): boolean {
	return getRunState(run) !== "running" && !!run.file && existsSync(run.file);
}

async function deriveWorkflowMonitor(run: WorkflowRunRecord, priority: "active" | "latest"): Promise<WorkflowMonitorModel> {
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
		agentsDone: Math.max(agentsDone, parsedEvents.agents.filter((agent) => agent.state === "completed" || agent.state === "failed" || agent.state === "cached").length),
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
	const active = runs.find((run) => isActiveRunRecord(run));
	const selected = active ?? runs[0];
	if (!selected) return [];
	return [await deriveWorkflowMonitor(selected, active ? "active" : "latest")];
}

const WORKFLOW_DASHBOARD_TABS = ["monitor", "agents", "sessions", "runs", "workflows", "patterns", "activity"] as const;
type WorkflowDashboardTab = (typeof WORKFLOW_DASHBOARD_TABS)[number];

class WorkflowDashboard {
	private tab: WorkflowDashboardTab;
	private workflowIndex = 0;
	private runIndex = 0;
	private activityIndex = 0;
	private sessionIndex = 0;
	private agentIndex = 0;
	private monitorAgentIndex = 0;
	private patternIndex = 0;

	constructor(
		private readonly workflows: WorkflowFile[],
		private runs: WorkflowRunRecord[],
		private activity: WorkflowActivityEntry[],
		private piSessions: PiSessionModel[],
		private monitorModels: WorkflowMonitorModel[],
		private agentEntries: WorkflowAgentEntry[],
		private readonly theme: any,
		private readonly requestRender: () => void,
		private readonly done: (result: WorkflowDashboardResult | null) => void,
		initialTab: WorkflowDashboardTab = "monitor",
	) {
		this.tab = initialTab;
	}

	setRuns(runs: WorkflowRunRecord[]): void {
		this.runs = runs;
		this.runIndex = Math.min(this.runIndex, Math.max(0, runs.length - 1));
	}

	setActivity(activity: WorkflowActivityEntry[]): void {
		this.activity = activity;
		this.activityIndex = Math.min(this.activityIndex, Math.max(0, activity.length - 1));
	}

	setPiSessions(sessions: PiSessionModel[]): void {
		this.piSessions = sessions;
		this.sessionIndex = Math.min(this.sessionIndex, Math.max(0, sessions.length - 1));
	}

	setAgentEntries(entries: WorkflowAgentEntry[]): void {
		this.agentEntries = entries;
		this.agentIndex = Math.min(this.agentIndex, Math.max(0, entries.length - 1));
	}

	setMonitorModels(models: WorkflowMonitorModel[]): void {
		this.monitorModels = models;
		const agentCount = this.selectedMonitor()?.agents.length ?? 0;
		this.monitorAgentIndex = Math.min(this.monitorAgentIndex, Math.max(0, agentCount - 1));
	}

	invalidate(): void {}

	private moveTab(delta: number): void {
		const current = WORKFLOW_DASHBOARD_TABS.indexOf(this.tab);
		const next = (current + delta + WORKFLOW_DASHBOARD_TABS.length) % WORKFLOW_DASHBOARD_TABS.length;
		this.tab = WORKFLOW_DASHBOARD_TABS[next]!;
		this.requestRender();
	}

	private selectedMonitor(): WorkflowMonitorModel | undefined {
		return this.monitorModels.find((model) => model.active) ?? this.monitorModels[0];
	}

	private selectedRun(): WorkflowRunRecord | undefined {
		if (this.tab === "monitor") return this.selectedMonitor()?.run;
		if (this.tab === "agents") return this.selectedAgentEntry()?.run;
		if (this.tab === "runs") return this.runs[this.runIndex];
		if (this.tab === "activity") {
			const entry = this.activity[this.activityIndex];
			return entry ? this.runs.find((candidate) => candidate.runId === entry.runId) : undefined;
		}
		return undefined;
	}

	private selectedAgentEntry(): WorkflowAgentEntry | undefined {
		return this.agentEntries[this.agentIndex];
	}

	private selectedAgent(): AgentMonitorModel | undefined {
		if (this.tab === "agents") return this.selectedAgentEntry()?.agent;
		return this.selectedMonitor()?.agents[this.monitorAgentIndex];
	}

	private isDeleteInput(data: string): boolean {
		return data === "d" || matchesKey(data, Key.delete) || matchesKey(data, Key.backspace);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.done(null);
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.moveTab(1);
			return;
		}
		if (matchesKey(data, Key.left)) {
			this.moveTab(-1);
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.moveTab(1);
			return;
		}
		if (data === "m") {
			this.tab = "monitor";
			this.requestRender();
			return;
		}
		if (data === "n" || data === "A") {
			this.tab = "agents";
			this.requestRender();
			return;
		}
		if (data === "a") {
			this.tab = "activity";
			this.requestRender();
			return;
		}
		if (data === "s") {
			this.tab = "sessions";
			this.requestRender();
			return;
		}
		if (data === "w") {
			this.tab = "workflows";
			this.requestRender();
			return;
		}
		if (data === "p") {
			this.tab = "patterns";
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.up)) {
			if (this.tab === "monitor" && (this.selectedMonitor()?.agents.length ?? 0) > 0) this.monitorAgentIndex = Math.max(0, this.monitorAgentIndex - 1);
			else if (this.tab === "agents") this.agentIndex = Math.max(0, this.agentIndex - 1);
			else if (this.tab === "workflows") this.workflowIndex = Math.max(0, this.workflowIndex - 1);
			else if (this.tab === "patterns") this.patternIndex = Math.max(0, this.patternIndex - 1);
			else if (this.tab === "sessions") this.sessionIndex = Math.max(0, this.sessionIndex - 1);
			else if (this.tab === "runs") this.runIndex = Math.max(0, this.runIndex - 1);
			else if (this.tab === "activity") this.activityIndex = Math.max(0, this.activityIndex - 1);
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			if (this.tab === "monitor" && (this.selectedMonitor()?.agents.length ?? 0) > 0) this.monitorAgentIndex = Math.min(Math.max(0, (this.selectedMonitor()?.agents.length ?? 1) - 1), this.monitorAgentIndex + 1);
			else if (this.tab === "agents") this.agentIndex = Math.min(Math.max(0, this.agentEntries.length - 1), this.agentIndex + 1);
			else if (this.tab === "workflows") this.workflowIndex = Math.min(Math.max(0, this.workflows.length - 1), this.workflowIndex + 1);
			else if (this.tab === "patterns") this.patternIndex = Math.min(Math.max(0, WORKFLOW_PATTERN_CATALOG.length - 1), this.patternIndex + 1);
			else if (this.tab === "sessions") this.sessionIndex = Math.min(Math.max(0, this.piSessions.length - 1), this.sessionIndex + 1);
			else if (this.tab === "runs") this.runIndex = Math.min(Math.max(0, this.runs.length - 1), this.runIndex + 1);
			else if (this.tab === "activity") this.activityIndex = Math.min(Math.max(0, this.activity.length - 1), this.activityIndex + 1);
			this.requestRender();
			return;
		}
		if (this.tab === "workflows") {
			const workflow = this.workflows[this.workflowIndex];
			if (!workflow) return;
			if (matchesKey(data, Key.enter) || data === "g") this.done({ type: "graph", workflow });
			else if (data === "r") this.done({ type: "run", workflow });
			else if (this.isDeleteInput(data)) this.done({ type: "deleteWorkflow", workflow });
			return;
		}
		if (this.tab === "patterns") {
			const pattern = WORKFLOW_PATTERN_CATALOG[this.patternIndex];
			if (!pattern) return;
			if (matchesKey(data, Key.enter) || data === "n" || data === "u") this.done({ type: "newPattern", pattern });
			return;
		}
		if (this.tab === "sessions") {
			const session = this.piSessions[this.sessionIndex];
			if (!session) return;
			if (matchesKey(data, Key.enter)) this.done({ type: "switchSession", session });
			return;
		}
		const run = this.selectedRun();
		if (!run) return;
		if (this.tab === "monitor") {
			const agent = this.selectedAgent();
			if ((matchesKey(data, Key.enter) || data === "o") && agent) this.done({ type: "agent", run, agent });
			else if (matchesKey(data, Key.enter) || data === "v") this.done({ type: "view", run });
			else if (data === "g") this.done({ type: "graph", run });
			else if ((data === "c" || data === "x") && canCancelRun(run)) this.done({ type: "cancel", run });
			else if (data === "r" && canRerunRun(run)) this.done({ type: "rerun", run });
			else if (this.isDeleteInput(data)) this.done({ type: "deleteRun", run });
			return;
		}
		if (this.tab === "agents") {
			const agent = this.selectedAgent();
			if ((matchesKey(data, Key.enter) || data === "o") && agent) this.done({ type: "agent", run, agent });
			else if (matchesKey(data, Key.enter) || data === "v") this.done({ type: "view", run });
			else if (data === "g") this.done({ type: "graph", run });
			else if ((data === "c" || data === "x") && canCancelRun(run)) this.done({ type: "cancel", run });
			else if (data === "r" && canRerunRun(run)) this.done({ type: "rerun", run });
			else if (this.isDeleteInput(data)) this.done({ type: "deleteRun", run });
			return;
		}
		if (matchesKey(data, Key.enter) || data === "v") this.done({ type: "view", run });
		else if (data === "g") this.done({ type: "graph", run });
		else if ((data === "c" || data === "x") && canCancelRun(run)) this.done({ type: "cancel", run });
		else if (data === "r" && canRerunRun(run)) this.done({ type: "rerun", run });
		else if (this.isDeleteInput(data)) this.done({ type: "deleteRun", run });
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const w = width;
		const accent = (s: string) => this.theme.fg("accent", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const success = (s: string) => this.theme.fg("success", s);
		const error = (s: string) => this.theme.fg("error", s);
		const warning = (s: string) => this.theme.fg("warning", s);
		const line = (s: string) => truncateToWidth(s, w, "");
		const monitorTab = this.tab === "monitor" ? accent("[Monitor]") : muted(" Monitor ");
		const agentsTab = this.tab === "agents" ? accent("[Agents]") : muted(" Agents ");
		const sessionsTab = this.tab === "sessions" ? accent("[Sessions]") : muted(" Sessions ");
		const runsTab = this.tab === "runs" ? accent("[Runs]") : muted(" Runs ");
		const workflowTab = this.tab === "workflows" ? accent("[Workflows]") : muted(" Workflows ");
		const patternsTab = this.tab === "patterns" ? accent("[Patterns]") : muted(" Patterns ");
		const activityTab = this.tab === "activity" ? accent("[Activity]") : muted(" Activity ");
		const activeCount = this.runs.filter((run) => canCancelRun(run)).length;
		const help = this.tab === "patterns"
			? "←→/Tab tabs • ↑↓ navigate catalog • Enter/n use pattern • q/esc close"
			: this.tab === "workflows"
				? "←→/Tab tabs • ↑↓ navigate • Enter/g graph • r run • d/delete workflow • q/esc close"
				: this.tab === "sessions"
					? "←→/Tab tabs • ↑↓ select Pi session • Enter switch • q/esc close"
					: this.tab === "monitor"
					? "←→/Tab tabs • ↑↓ agents • Enter/o agent detail • v run • g graph • c/x cancel active • r rerun • d/delete run • q/esc close"
					: this.tab === "agents"
						? "←→/Tab tabs • ↑↓ select agent • Enter/o detail+prompt • v run • g graph • c/x cancel active • r rerun • d/delete run • q/esc close"
						: "←→/Tab tabs • ↑↓ navigate • Enter/v view • g graph • c/x cancel active • r rerun • d/delete run • q/esc close";
		const lines: string[] = [
			line(accent("Pi Dynamic Workflows") + muted("  •  ") + monitorTab + " " + agentsTab + " " + sessionsTab + " " + runsTab + " " + workflowTab + " " + patternsTab + " " + activityTab + (activeCount ? accent(`  ▶ ${activeCount} active`) : "")),
			line(muted(help)),
			line(muted("─".repeat(Math.min(w, 120)))),
		];

		if (this.tab === "monitor") this.renderMonitor(lines, line, accent, muted, success, error, warning);
		else if (this.tab === "agents") this.renderAgents(lines, line, accent, muted, success, error, warning);
		else if (this.tab === "sessions") this.renderSessions(lines, line, accent, muted, success, warning);
		else if (this.tab === "runs") this.renderRuns(lines, line, accent, muted, success, error);
		else if (this.tab === "workflows") this.renderWorkflows(lines, line, accent, muted, warning);
		else if (this.tab === "patterns") this.renderPatterns(lines, line, accent, muted, warning);
		else this.renderActivity(lines, line, accent, muted, success, error, warning);
		return lines;
	}

	private renderMonitor(
		lines: string[],
		line: (s: string) => string,
		accent: (s: string) => string,
		muted: (s: string) => string,
		success: (s: string) => string,
		error: (s: string) => string,
		warning: (s: string) => string,
	): void {
		const model = this.selectedMonitor();
		if (!model) {
			lines.push(line(warning("No workflow runs found.")));
			lines.push(line(muted("Start one with /workflow start <name> {json} or dynamic_workflow action=start.")));
			return;
		}

		const stateColor = model.state === "completed" ? success : model.state === "running" ? accent : model.state === "stale" ? warning : error;
		const label = (name: string, value: string) => lines.push(line(`${muted(padRightVisible(`${name}:`, 11))} ${value}`));
		const statusTail = model.active ? accent("active") : model.stale ? warning("stale") : muted("inactive");
		const title = model.priority === "active" ? "Active run" : "Latest run";
		lines.push(line(accent(title)));
		label("workflow", model.workflow);
		label("state", `${stateColor(getRunStatusLabel(model.run))} ${muted("•")} ${statusTail}`);
		label("elapsed", formatElapsedMs(model.elapsedMs));
		label("agents", `${model.agentsDone}/${model.agentsStarted} done/started`);
		label("parallel", `${model.agentConcurrency && model.agentConcurrency > 0 ? `${model.parallelAgents}/${model.agentConcurrency}` : model.parallelAgents} running${model.peakParallelAgents === undefined ? "" : ` • peak:${model.peakParallelAgents}`}`);
		label("bash", `${model.bashDone} done`);
		label("artifacts", String(model.artifactCount));
		label("run", model.runId);
		label("runDir", model.runDir);
		const last = model.lastLog ? `${model.lastLog.time.slice(11, 19)} ${renderSafeInline(model.lastLog.message)}` : "No logs recorded yet.";
		label("last", last);
		const actions = model.agents.length > 0 ? ["←→ tabs", "↑↓ select agent", "Enter/o agent output", "v run", "g graph"] : ["←→ tabs", "Enter/v view", "g graph"];
		if (model.canCancel) actions.push("c/x cancel active");
		if (model.canRerun) actions.push("r rerun (confirm)");
		actions.push("d/delete run artifacts");
		lines.push(line(muted("")));
		lines.push(line(muted(actions.join(" • "))));
		this.renderMonitorAgents(lines, line, model, accent, muted, success, error, warning);
	}

	private agentStateLabel(agent: AgentMonitorModel, accent: (s: string) => string, muted: (s: string) => string, success: (s: string) => string, error: (s: string) => string): string {
		if (agent.state === "completed") return success("✓ done");
		if (agent.state === "running") return accent("▶ running");
		if (agent.state === "cached") return muted("♻ cached");
		if (agent.state === "failed") return error("✗ failed");
		return muted("? unknown");
	}

	private renderMonitorAgents(
		lines: string[],
		line: (s: string) => string,
		model: WorkflowMonitorModel,
		accent: (s: string) => string,
		muted: (s: string) => string,
		success: (s: string) => string,
		error: (s: string) => string,
		warning: (s: string) => string,
	): void {
		if (model.agents.length === 0) return;
		lines.push(line(muted("")));
		lines.push(line(accent(`Agents (${model.agents.length})`) + muted(` • parallel ${model.agentConcurrency && model.agentConcurrency > 0 ? `${model.parallelAgents}/${model.agentConcurrency}` : model.parallelAgents}${model.peakParallelAgents === undefined ? "" : ` • peak ${model.peakParallelAgents}`}`)));
		const start = Math.max(0, Math.min(this.monitorAgentIndex - 6, model.agents.length - 12));
		const visible = model.agents.slice(start, start + 12);
		for (let i = 0; i < visible.length; i++) {
			const index = start + i;
			const agent = visible[i]!;
			const selected = index === this.monitorAgentIndex;
			const prefix = selected ? accent("› ") : "  ";
			const state = this.agentStateLabel(agent, accent, muted, success, error);
			const elapsed = agent.elapsedMs === undefined ? "elapsed:…" : `elapsed:${formatElapsedMs(agent.elapsedMs)}`;
			const phase = formatAgentPhase(agent);
			const code = agent.code === undefined ? "" : muted(` code:${agent.code}`);
			const prompt = agent.promptAvailable ? success("prompt✓") : warning("prompt?");
			const schema = agent.schemaOk === undefined ? "" : muted(` schema:${agent.schemaOk ? "ok" : "bad"}`);
			const tools = muted(` tools:${agent.tools?.length ? agent.tools.length : "default"}`);
			const skills = muted(` skills:${agent.skills?.length ? agent.skills.length : agent.includeSkills === false ? "off" : "default"}`);
			const extensions = muted(` ext:${agent.extensions?.length ? agent.extensions.length : agent.includeExtensions ? "default" : "off"}`);
			const keys = muted(` keys:${agent.keys?.length ? agent.keys.length : agent.isolatedEnv ? "none" : "default"}${agent.missingKeys?.length ? ` missing:${agent.missingKeys.length}` : ""}`);
			lines.push(line(`${prefix}${state} #${agent.id}${phase ? ` ${accent(phase)}` : ""} ${renderSafeInline(agent.name)} ${muted(elapsed)}${code} ${prompt}${schema}${tools}${skills}${extensions}${keys}`));
		}
		const selected = this.selectedAgent();
		if (!selected) return;
		lines.push(line(muted("")));
		lines.push(line(accent("Selected agent")));
		lines.push(line(`agent: #${selected.id} ${formatAgentPhase(selected) ? `${formatAgentPhase(selected)} ` : ""}${selected.name}`));
		lines.push(line(`state: ${renderSafeInline(selected.state)}${selected.elapsedMs === undefined ? "" : ` • ${formatElapsedMs(selected.elapsedMs)}`}${selected.code === undefined ? "" : ` • code ${selected.code}`}`));
		if (formatAgentPhase(selected)) lines.push(line(`phase: ${formatAgentPhase(selected)}${selected.phaseLabel ? muted(` • ${selected.phaseLabel}`) : ""}`));
		lines.push(line(`prompt: ${selected.promptAvailable ? success("available") : warning("not available")} ${selected.artifactPath ? muted(`• ${selected.artifactPath}`) : ""}`));
		lines.push(line(`tools: ${selected.tools?.length ? selected.tools.join(", ") : "default"}${selected.excludeTools?.length ? ` • exclude: ${selected.excludeTools.join(", ")}` : ""}`));
		lines.push(line(`skills: ${selected.skills?.length ? `${selected.skills.join(", ")}${selected.includeSkills ? " + discovery" : " (explicit only)"}` : selected.includeSkills === false ? "disabled" : "default discovery"}`));
		lines.push(line(`extensions: ${selected.extensions?.length ? `${selected.extensions.join(", ")}${selected.includeExtensions ? " + discovery" : " (explicit only)"}` : selected.includeExtensions ? "default discovery" : "disabled"}`));
		lines.push(line(`keys: ${selected.keys?.length ? selected.keys.join(", ") : selected.isolatedEnv ? "none selected" : "default inherited environment"}${selected.missingKeys?.length ? warning(` • missing: ${selected.missingKeys.join(", ")}`) : ""}`));
		if (selected.promptPreview) lines.push(line(`prompt preview: ${renderSafeInline(compactInline(selected.promptPreview, 220))}`));
		if (selected.output) lines.push(line(`output: ${renderSafeInline(compactInline(selected.output, 220))}`));
	}

	private renderAgents(
		lines: string[],
		line: (s: string) => string,
		accent: (s: string) => string,
		muted: (s: string) => string,
		success: (s: string) => string,
		error: (s: string) => string,
		warning: (s: string) => string,
	): void {
		if (this.agentEntries.length === 0) {
			lines.push(line(warning("No workflow agents found yet.")));
			lines.push(line(muted("Start a workflow with subagents, then return here to inspect prompts, state, artifacts, and output.")));
			return;
		}
		const running = this.agentEntries.filter((entry) => entry.agent.state === "running").length;
		const failed = this.agentEntries.filter((entry) => entry.agent.state === "failed").length;
		const cached = this.agentEntries.filter((entry) => entry.agent.state === "cached").length;
		const activeRuns = this.runs.filter((run) => getRunState(run) === "running");
		const parallelNow = activeRuns.reduce((sum, run) => sum + getRunParallelAgents(run), 0);
		const parallelLimit = activeRuns.reduce((sum, run) => sum + (getRunAgentConcurrency(run) ?? 0), 0);
		const parallelText = parallelLimit > 0 ? `${parallelNow}/${parallelLimit}` : String(parallelNow);
		lines.push(line(`${accent("All agents")} ${muted(`(${this.agentEntries.length})`)} ${accent(`parallel:${parallelText}`)} ${running ? accent(`running:${running}`) : muted("running:0")} ${failed ? error(`failed:${failed}`) : muted("failed:0")} ${cached ? muted(`cached:${cached}`) : ""}`));
		const start = Math.max(0, Math.min(this.agentIndex - 7, this.agentEntries.length - 14));
		const visible = this.agentEntries.slice(start, start + 14);
		for (let i = 0; i < visible.length; i++) {
			const index = start + i;
			const entry = visible[i]!;
			const selected = index === this.agentIndex;
			const prefix = selected ? accent("› ") : "  ";
			const state = this.agentStateLabel(entry.agent, accent, muted, success, error);
			const elapsed = entry.agent.elapsedMs === undefined ? "elapsed:…" : `elapsed:${formatElapsedMs(entry.agent.elapsedMs)}`;
			const phase = formatAgentPhase(entry.agent);
			const prompt = entry.agent.promptAvailable ? success("prompt✓") : warning("prompt?");
			const schema = entry.agent.schemaOk === undefined ? "" : muted(` schema:${entry.agent.schemaOk ? "ok" : "bad"}`);
			const tools = muted(` tools:${entry.agent.tools?.length ? entry.agent.tools.length : "default"}`);
			const skills = muted(` skills:${entry.agent.skills?.length ? entry.agent.skills.length : entry.agent.includeSkills === false ? "off" : "default"}`);
			const extensions = muted(` ext:${entry.agent.extensions?.length ? entry.agent.extensions.length : entry.agent.includeExtensions ? "default" : "off"}`);
			const keys = muted(` keys:${entry.agent.keys?.length ? entry.agent.keys.length : entry.agent.isolatedEnv ? "none" : "default"}${entry.agent.missingKeys?.length ? ` missing:${entry.agent.missingKeys.length}` : ""}`);
			lines.push(line(`${prefix}${state} #${entry.agent.id}${phase ? ` ${accent(phase)}` : ""} ${renderSafeInline(entry.agent.name)} ${muted(`— ${entry.run.workflow} ${entry.run.runId.slice(-12)}`)} ${muted(elapsed)} ${prompt}${schema}${tools}${skills}${extensions}${keys}`));
		}
		const selected = this.selectedAgentEntry();
		if (!selected) return;
		const agent = selected.agent;
		const run = selected.run;
		lines.push(line(muted("")));
		lines.push(line(accent("Selected agent")));
		lines.push(line(`workflow: ${run.workflow}`));
		lines.push(line(`run: ${run.runId}`));
		lines.push(line(`parallel: ${formatParallelAgents(run)}`));
		lines.push(line(`agent: #${agent.id} ${formatAgentPhase(agent) ? `${formatAgentPhase(agent)} ` : ""}${agent.name}`));
		lines.push(line(`state: ${renderSafeInline(agent.state)}${agent.elapsedMs === undefined ? "" : ` • ${formatElapsedMs(agent.elapsedMs)}`}${agent.code === undefined ? "" : ` • code ${agent.code}`}${agent.schemaOk === undefined ? "" : ` • schema ${agent.schemaOk ? "ok" : "bad"}`}`));
		if (formatAgentPhase(agent)) lines.push(line(`phase: ${formatAgentPhase(agent)}${agent.phaseLabel ? muted(` • ${agent.phaseLabel}`) : ""}`));
		lines.push(line(`prompt: ${agent.promptAvailable ? success("available") : warning("not available")} ${agent.artifactPath ? muted(`• ${agent.artifactPath}`) : ""}`));
		lines.push(line(`tools: ${agent.tools?.length ? agent.tools.join(", ") : "default"}${agent.excludeTools?.length ? ` • exclude: ${agent.excludeTools.join(", ")}` : ""}`));
		lines.push(line(`skills: ${agent.skills?.length ? `${agent.skills.join(", ")}${agent.includeSkills ? " + discovery" : " (explicit only)"}` : agent.includeSkills === false ? "disabled" : "default discovery"}`));
		lines.push(line(`extensions: ${agent.extensions?.length ? `${agent.extensions.join(", ")}${agent.includeExtensions ? " + discovery" : " (explicit only)"}` : agent.includeExtensions ? "default discovery" : "disabled"}`));
		lines.push(line(`keys: ${agent.keys?.length ? agent.keys.join(", ") : agent.isolatedEnv ? "none selected" : "default inherited environment"}${agent.missingKeys?.length ? warning(` • missing: ${agent.missingKeys.join(", ")}`) : ""}`));
		if (agent.promptPreview) lines.push(line(`prompt preview: ${renderSafeInline(compactInline(agent.promptPreview, 260))}`));
		if (agent.output) lines.push(line(`output: ${renderSafeInline(compactInline(agent.output, 260))}`));
		const actions = ["Enter/o opens output+prompt", "v run", "g graph"];
		if (canCancelRun(run)) actions.push("c/x cancel active");
		if (canRerunRun(run)) actions.push("r rerun (confirm)");
		actions.push("d/delete run artifacts");
		lines.push(line(muted(actions.join(" • "))));
	}

	private renderSessions(
		lines: string[],
		line: (s: string) => string,
		accent: (s: string) => string,
		muted: (s: string) => string,
		success: (s: string) => string,
		warning: (s: string) => string,
	): void {
		if (this.piSessions.length === 0) {
			lines.push(line(warning("No live Pi TUI/RPC sessions found.")));
			lines.push(line(muted("Persistent Pi sessions appear here after this extension starts and writes a heartbeat.")));
			return;
		}
		const live = this.piSessions.filter((session) => session.live).length;
		const stale = this.piSessions.length - live;
		lines.push(line(`${accent("Pi sessions")} ${muted(`(${this.piSessions.length})`)} ${live ? success(`live:${live}`) : muted("live:0")} ${stale ? warning(`stale:${stale}`) : muted("stale:0")} ${muted(`heartbeat:${formatElapsedMs(PI_SESSION_HEARTBEAT_MS)}`)}`));
		const start = Math.max(0, Math.min(this.sessionIndex - 6, this.piSessions.length - 12));
		const visible = this.piSessions.slice(start, start + 12);
		for (let i = 0; i < visible.length; i++) {
			const index = start + i;
			const session = visible[i]!;
			const selected = index === this.sessionIndex;
			const prefix = selected ? accent("› ") : "  ";
			const state = session.live ? success("● live") : warning("○ stale");
			const current = session.current ? accent(" this") : "";
			const name = session.sessionName ? ` ${renderSafeInline(session.sessionName)}` : "";
			const idle = session.idle === undefined ? "" : muted(` idle:${session.idle ? "yes" : "no"}`);
			const workflows = session.activeWorkflowRuns ? accent(` workflows:${session.activeWorkflowRuns}`) : muted(" workflows:0");
			const age = Number.isFinite(session.ageMs) ? `${formatElapsedMs(session.ageMs)} ago` : "unknown";
			lines.push(line(`${prefix}${state} ${session.mode} pid:${session.pid}${current}${name} ${muted(`updated:${age}`)}${idle}${workflows}`));
		}
		const selected = this.piSessions[this.sessionIndex];
		if (!selected) return;
		lines.push(line(muted("")));
		lines.push(line(accent("Selected Pi session")));
		lines.push(line(`status: ${selected.live ? success("live") : warning(`stale${selected.staleReason ? ` • ${selected.staleReason}` : ""}`)}${selected.current ? accent(" • this process") : ""}`));
		lines.push(line(`mode: ${selected.mode} • pid: ${selected.pid} • idle: ${selected.idle === undefined ? "unknown" : selected.idle ? "yes" : "no"}`));
		lines.push(line(`session: ${selected.sessionName ? `${selected.sessionName} • ` : ""}${selected.sessionId ?? "unknown"}`));
		lines.push(line(`started: ${selected.startedAt} • updated: ${selected.updatedAt}`));
		lines.push(line(`workflows: ${selected.activeWorkflowRuns ?? 0} active • trusted: ${selected.trusted === undefined ? "unknown" : selected.trusted ? "yes" : "no"}`));
		lines.push(line(`cwd: ${selected.cwd}`));
		lines.push(line(`session file: ${selected.sessionFile ?? "(in-memory or unavailable)"}`));
		lines.push(line(`registry: ${selected.file}`));
		const action = selected.current
			? "Already in this session."
			: selected.sessionFile
				? "Enter switches this Pi to the selected session file."
				: "Enter unavailable: no session file recorded.";
		lines.push(line(muted(action)));
		lines.push(line(muted(`Heartbeat records are removed on clean shutdown; stale rows usually mean the Pi process died without cleanup.`)));
	}

	private renderWorkflows(
		lines: string[],
		line: (s: string) => string,
		accent: (s: string) => string,
		muted: (s: string) => string,
		warning: (s: string) => string,
	): void {
		if (this.workflows.length === 0) {
			lines.push(line(warning("No workflows found.")));
			lines.push(line(muted("Create one with /workflow new <name> or dynamic_workflow action=write.")));
			return;
		}
		const start = Math.max(0, Math.min(this.workflowIndex - 6, this.workflows.length - 12));
		const visible = this.workflows.slice(start, start + 12);
		for (let i = 0; i < visible.length; i++) {
			const index = start + i;
			const workflow = visible[i]!;
			const selected = index === this.workflowIndex;
			const prefix = selected ? accent("› ") : "  ";
			const scope = workflow.scope === "project" ? accent("project") : muted("global");
			lines.push(line(`${prefix}${workflow.name} ${muted("(")}${scope}${muted(")")} ${muted(workflow.relativePath)}`));
		}
		const selected = this.workflows[this.workflowIndex];
		if (selected) {
			lines.push(line(muted("")));
			lines.push(line(accent("Selected workflow")));
			lines.push(line(`name: ${selected.name}`));
			lines.push(line(`scope: ${selected.scope}`));
			lines.push(line(`path: ${selected.path}`));
			lines.push(line(muted("Enter/g opens graph • r runs with JSON + confirm • d/delete removes workflow file")));
		}
	}

	private renderPatterns(
		lines: string[],
		line: (s: string) => string,
		accent: (s: string) => string,
		muted: (s: string) => string,
		warning: (s: string) => string,
	): void {
		if (WORKFLOW_PATTERN_CATALOG.length === 0) {
			lines.push(line(warning("No workflow patterns registered.")));
			return;
		}
		lines.push(line(`${accent("Pattern catalog")} ${muted(`(${WORKFLOW_PATTERN_CATALOG.length})`)} ${muted("• choose a scaffold, then edit before saving")}`));
		const start = Math.max(0, Math.min(this.patternIndex - 6, WORKFLOW_PATTERN_CATALOG.length - 12));
		const visible = WORKFLOW_PATTERN_CATALOG.slice(start, start + 12);
		for (let i = 0; i < visible.length; i++) {
			const index = start + i;
			const pattern = visible[i]!;
			const selected = index === this.patternIndex;
			const prefix = selected ? accent("› ") : "  ";
			const aliasHint = getPatternAliases(pattern)[0];
			lines.push(line(`${prefix}${pattern.key} ${muted("—")} ${pattern.title}${aliasHint ? muted(` aka:${aliasHint}`) : ""} ${muted(`(${pattern.primitives.join(" + ")})`)}`));
		}
		const selected = WORKFLOW_PATTERN_CATALOG[this.patternIndex];
		if (!selected) return;
		const aliases = getPatternAliases(selected);
		const useCases = getPatternUseCases(selected);
		lines.push(line(muted("")));
		lines.push(line(accent("Selected pattern")));
		lines.push(line(`key: ${selected.key}${aliases.length ? muted(` • aliases: ${aliases.join(", ")}`) : ""}`));
		lines.push(line(`title: ${selected.title}`));
		lines.push(line(`summary: ${selected.blurb}`));
		lines.push(line(`use when: ${selected.useWhen}`));
		if (useCases.length) {
			lines.push(line(accent("Example use cases")));
			for (const useCase of useCases.slice(0, 4)) lines.push(line(`- ${useCase}`));
		}
		lines.push(line(`input: ${selected.inputHint}`));
		lines.push(line(`primitives: ${selected.primitives.join(", ")}`));
		lines.push(line(`draft name: ${selected.defaultName}`));
		lines.push(line(muted("Enter/n creates a project workflow draft from this pattern; you can edit before save.")));
	}

	private renderRuns(
		lines: string[],
		line: (s: string) => string,
		accent: (s: string) => string,
		muted: (s: string) => string,
		success: (s: string) => string,
		error: (s: string) => string,
	): void {
		if (this.runs.length === 0) {
			lines.push(line(muted("No workflow runs found.")));
			return;
		}
		const start = Math.max(0, Math.min(this.runIndex - 6, this.runs.length - 12));
		const visible = this.runs.slice(start, start + 12);
		for (let i = 0; i < visible.length; i++) {
			const index = start + i;
			const run = visible[i]!;
			const selected = index === this.runIndex;
			const prefix = selected ? accent("› ") : "  ";
			const state = getRunState(run);
			const status = state === "completed" ? success("✓") : state === "running" ? accent("▶") : state === "stale" ? muted("?") : error(state === "cancelled" ? "■" : "✗");
			const bg = run.background ? " bg" : "";
			const resumable = isResumableState(state) ? muted(" resumable") : "";
			const cached = getRunCachedCalls(run) > 0 ? muted(` cached:${getRunCachedCalls(run)}`) : "";
			const parallelCompact = formatParallelAgentsCompact(run);
			const parallel = parallelCompact === "-" ? "" : muted(` parallel:${parallelCompact}`);
			lines.push(line(`${prefix}${status} ${run.workflow}${bg} ${muted(run.runId)} ${getRunStatusLabel(run)} ${formatElapsedMs(getRunElapsedMs(run, state))} agents:${run.agentCount}${parallel}${resumable}${cached}`));
		}
		const selected = this.runs[this.runIndex];
		if (selected) {
			lines.push(line(muted("")));
			lines.push(line(accent("Selected run")));
			lines.push(line(`status: ${getRunStatusLabel(selected)}`));
			lines.push(line(`run: ${selected.runId}`));
			lines.push(line(`parallel: ${formatParallelAgents(selected)}`));
			lines.push(line(`dir: ${selected.runDir}`));
			for (const logEntry of getRunLogs(selected).slice(-5)) lines.push(line(`${muted(logEntry.time.slice(11, 19))} ${renderSafeInline(logEntry.message)}`));
			const selectedState = getRunState(selected);
			const actions = ["Enter/v view", "g graph"];
			if (canCancelRun(selected)) actions.push("c/x cancel active");
			if (canRerunRun(selected)) actions.push("r rerun (confirm)");
			if (!canCancelRun(selected)) actions.push("d/delete run artifacts");
			if (isResumableState(selectedState)) actions.push(`/workflow resume ${selected.runId}`);
			lines.push(line(muted(actions.join(" • "))));
		}
	}

	private renderActivity(
		lines: string[],
		line: (s: string) => string,
		accent: (s: string) => string,
		muted: (s: string) => string,
		success: (s: string) => string,
		error: (s: string) => string,
		warning: (s: string) => string,
	): void {
		const active = this.runs.filter((run) => canCancelRun(run));
		lines.push(line(accent("Active runs")));
		if (active.length === 0) {
			lines.push(line(muted("No active background workflow runs.")));
		} else {
			for (const run of active.slice(0, 5)) {
				const lastLog = getRunLogs(run).slice(-1)[0];
				lines.push(line(`${accent("▶")} ${run.workflow} ${muted(run.runId)} ${formatElapsedMs(getRunElapsedMs(run))} agents:${run.agentCount} parallel:${formatParallelAgentsCompact(run)}${lastLog ? muted(` — ${renderSafeInline(lastLog.message)}`) : ""}`));
			}
		}

		lines.push(line(muted("")));
		lines.push(line(accent("Recent activity")));
		if (this.activity.length === 0) {
			lines.push(line(warning("No workflow activity yet.")));
			return;
		}
		const start = Math.max(0, Math.min(this.activityIndex - 7, this.activity.length - 14));
		const visible = this.activity.slice(start, start + 14);
		for (let i = 0; i < visible.length; i++) {
			const index = start + i;
			const entry = visible[i]!;
			const selected = index === this.activityIndex;
			const prefix = selected ? accent("› ") : "  ";
			const status = entry.state === "completed" ? success("✓") : entry.state === "running" ? accent("▶") : entry.state === "stale" ? muted("?") : error(entry.state === "cancelled" ? "■" : "✗");
			const details = entry.details === undefined ? "" : muted(` — ${renderSafeInline(compactInline(entry.details, 120))}`);
			lines.push(line(`${prefix}${muted(entry.time.slice(11, 19))} ${status} ${entry.workflow} ${muted(entry.runId.slice(-12))} ${renderSafeInline(entry.message)}${details}`));
		}
		const selected = this.activity[this.activityIndex];
		if (selected) {
			lines.push(line(muted("")));
			lines.push(line(accent("Selected activity")));
			lines.push(line(`workflow: ${selected.workflow}`));
			lines.push(line(`run: ${selected.runId}`));
			lines.push(line(`time: ${selected.time}`));
			const run = this.runs.find((candidate) => candidate.runId === selected.runId);
			const actions = ["Enter/v opens full run timeline", "g graph"];
			if (run && canCancelRun(run)) actions.push("c/x cancel active");
			if (run && canRerunRun(run)) actions.push("r rerun (confirm)");
			if (run && !canCancelRun(run)) actions.push("d/delete run artifacts");
			lines.push(line(muted(actions.join(" • "))));
		}
	}
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
		const result = await runWorkflow(pi, ctx, workflow, input, limits, signal, (logs, status) => {
			onProgress?.(logs, status);
			if (ctx.hasUI) {
				setWorkflowRunningStatus(ctx, workflow.name, logs, status);
				setWorkflowWidget(ctx, workflow.name, logs, status);
			}
		}, prepared);
		setWorkflowFinishedStatus(ctx, result);
		return result;
	} catch (err) {
		setWorkflowErrorStatus(ctx, workflow.name);
		throw err;
	} finally {
		clearWorkflowWidget(ctx);
	}
}

async function runWorkflowFromUi(pi: ExtensionAPI, ctx: ExtensionContext, workflow: WorkflowFile, input: unknown): Promise<WorkflowRunRecord> {
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
			return { name: run.workflow, scope: run.scope, path: run.file, relativePath: path.basename(run.file) };
		}
		return undefined;
	}
}

async function loadRerunInput(ctx: ExtensionContext, run: WorkflowRunRecord): Promise<{ input: unknown; source: string } | undefined> {
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

type DashboardCommandSubmitter = (command: string) => void;
type DashboardOpener = (submitCommand?: DashboardCommandSubmitter) => Promise<void>;

const WORKFLOW_DASHBOARD_DOWN_EDITOR_MARKER = "__dynamicWorkflowDashboardDownEditor";

class WorkflowDashboardDownEditor implements EditorComponent {
	readonly [WORKFLOW_DASHBOARD_DOWN_EDITOR_MARKER] = true;
	actionHandlers: Map<string, () => void>;
	private opening = false;

	constructor(
		private readonly base: EditorComponent,
		private openDashboard: DashboardOpener,
		private openAgentsDashboard: DashboardOpener = openDashboard,
	) {
		const customBase = base as { actionHandlers?: unknown };
		this.actionHandlers = customBase.actionHandlers instanceof Map ? customBase.actionHandlers as Map<string, () => void> : new Map<string, () => void>();
	}

	setWorkflowDashboardOpen(openDashboard: DashboardOpener, openAgentsDashboard: DashboardOpener = openDashboard): void {
		this.openDashboard = openDashboard;
		this.openAgentsDashboard = openAgentsDashboard;
	}

	get focused(): boolean {
		return Boolean((this.base as { focused?: boolean }).focused);
	}

	set focused(value: boolean) {
		(this.base as { focused?: boolean }).focused = value;
	}

	get wantsKeyRelease(): boolean | undefined {
		return this.base.wantsKeyRelease;
	}

	set wantsKeyRelease(value: boolean | undefined) {
		this.base.wantsKeyRelease = value;
	}

	get onSubmit(): ((text: string) => void) | undefined {
		return this.base.onSubmit;
	}

	set onSubmit(handler: ((text: string) => void) | undefined) {
		this.base.onSubmit = handler;
	}

	get onChange(): ((text: string) => void) | undefined {
		return this.base.onChange;
	}

	set onChange(handler: ((text: string) => void) | undefined) {
		this.base.onChange = handler;
	}

	get borderColor(): ((str: string) => string) | undefined {
		return this.base.borderColor;
	}

	set borderColor(color: ((str: string) => string) | undefined) {
		this.base.borderColor = color;
	}

	get onEscape(): (() => void) | undefined {
		return (this.base as { onEscape?: () => void }).onEscape;
	}

	set onEscape(handler: (() => void) | undefined) {
		(this.base as { onEscape?: () => void }).onEscape = handler;
	}

	get onCtrlD(): (() => void) | undefined {
		return (this.base as { onCtrlD?: () => void }).onCtrlD;
	}

	set onCtrlD(handler: (() => void) | undefined) {
		(this.base as { onCtrlD?: () => void }).onCtrlD = handler;
	}

	get onPasteImage(): (() => void) | undefined {
		return (this.base as { onPasteImage?: () => void }).onPasteImage;
	}

	set onPasteImage(handler: (() => void) | undefined) {
		(this.base as { onPasteImage?: () => void }).onPasteImage = handler;
	}

	get onExtensionShortcut(): ((data: string) => boolean | void) | undefined {
		return (this.base as { onExtensionShortcut?: (data: string) => boolean | void }).onExtensionShortcut;
	}

	set onExtensionShortcut(handler: ((data: string) => boolean | void) | undefined) {
		(this.base as { onExtensionShortcut?: (data: string) => boolean | void }).onExtensionShortcut = handler;
	}

	render(width: number): string[] {
		return this.base.render(width);
	}

	invalidate(): void {
		this.base.invalidate();
	}

	getText(): string {
		return this.base.getText();
	}

	setText(text: string): void {
		this.base.setText(text);
	}

	addToHistory(text: string): void {
		this.base.addToHistory?.(text);
	}

	insertTextAtCursor(text: string): void {
		this.base.insertTextAtCursor?.(text);
	}

	getExpandedText(): string {
		return this.base.getExpandedText?.() ?? this.base.getText();
	}

	setAutocompleteProvider(provider: Parameters<NonNullable<EditorComponent["setAutocompleteProvider"]>>[0]): void {
		this.base.setAutocompleteProvider?.(provider);
	}

	setPaddingX(padding: number): void {
		this.base.setPaddingX?.(padding);
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.base.setAutocompleteMaxVisible?.(maxVisible);
	}

	handleInput(data: string): void {
		const opensMonitor = matchesKey(data, Key.down);
		const opensAgents = matchesKey(data, Key.left);
		if (!opensMonitor && !opensAgents) {
			this.base.handleInput(data);
			return;
		}

		const cursorBefore = this.getCursor();
		const textBefore = this.base.getText();
		const autocompleteBefore = this.isShowingAutocomplete();
		this.base.handleInput(data);
		const autocompleteAfter = this.isShowingAutocomplete();
		const cursorAfter = this.getCursor();
		const textAfter = this.base.getText();

		if (autocompleteBefore || autocompleteAfter) return;
		if (!cursorBefore || !cursorAfter) return;
		if (textBefore !== textAfter || !sameEditorCursor(cursorBefore, cursorAfter)) return;
		if (this.opening) return;

		this.opening = true;
		const open = opensAgents ? this.openAgentsDashboard : this.openDashboard;
		void open((command) => this.submitCommand(command)).finally(() => {
			this.opening = false;
		});
	}

	private submitCommand(command: string): void {
		const submit = this.base.onSubmit;
		if (typeof submit === "function") {
			try {
				void Promise.resolve(submit(command)).catch(() => undefined);
			} catch {
				// Fall back to leaving the command ready for manual Enter if direct submission fails.
				this.base.setText(command);
			}
			return;
		}
		this.base.setText(command);
	}

	private getCursor(): { line: number; col: number } | undefined {
		const editor = this.base as { getCursor?: () => { line: number; col: number } };
		if (typeof editor.getCursor !== "function") return undefined;
		try {
			return editor.getCursor.call(this.base);
		} catch {
			return undefined;
		}
	}

	private isShowingAutocomplete(): boolean {
		const editor = this.base as { isShowingAutocomplete?: () => boolean };
		if (typeof editor.isShowingAutocomplete !== "function") return false;
		try {
			return editor.isShowingAutocomplete.call(this.base);
		} catch {
			return false;
		}
	}
}

function sameEditorCursor(a: { line: number; col: number }, b: { line: number; col: number }): boolean {
	return a.line === b.line && a.col === b.col;
}

function installWorkflowDashboardDownEditor(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;
	const previous = ctx.ui.getEditorComponent?.();
	ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		const openMonitor = async (submitCommand?: DashboardCommandSubmitter) => await openWorkflowDashboard(pi, ctx, "monitor", { submitCommand });
		const openAgents = async (submitCommand?: DashboardCommandSubmitter) => await openWorkflowDashboard(pi, ctx, "agents", { submitCommand });
		const base = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
		const existing = base as EditorComponent & { [WORKFLOW_DASHBOARD_DOWN_EDITOR_MARKER]?: boolean; setWorkflowDashboardOpen?: (openDashboard: DashboardOpener, openAgentsDashboard?: DashboardOpener) => void };
		if (existing[WORKFLOW_DASHBOARD_DOWN_EDITOR_MARKER] && typeof existing.setWorkflowDashboardOpen === "function") {
			existing.setWorkflowDashboardOpen(openMonitor, openAgents);
			return existing;
		}
		return new WorkflowDashboardDownEditor(base, openMonitor, openAgents);
	});
}

async function createWorkflowDraftFromPattern(ctx: ExtensionContext, pattern: WorkflowPattern): Promise<WorkflowFile | undefined> {
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
		options?: { withSession?: (ctx: { ui: { notify?: (message: string, kind?: "info" | "warning" | "error") => void } }) => Promise<void> | void },
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

async function switchToPiSession(ctx: ExtensionContext, session: PiSessionModel, options: WorkflowDashboardOpenOptions = {}): Promise<void> {
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
		notify(ctx, "Cannot switch from this dashboard context. Open it from the prompt with /workflow sessions.", "warning");
		return;
	}
	if (!existsSync(sessionFile)) {
		notify(ctx, `Cannot switch: session file no longer exists: ${sessionFile}`, "warning");
		return;
	}
	const label = session.sessionName || session.sessionId || path.basename(sessionFile);
	const activeWarning = activeRuns.size > 0 ? `\n\nWarning: ${activeRuns.size} active workflow run(s) in this Pi will be cancelled by the session switch.` : "";
	const pidLine = session.pid > 0 ? `\nPID: ${session.pid}${session.live ? " (live)" : session.staleReason ? ` (${session.staleReason})` : ""}` : "";
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

async function openWorkflowDashboard(pi: ExtensionAPI, ctx: ExtensionContext, initialTab: WorkflowDashboardTab = "monitor", options: WorkflowDashboardOpenOptions = {}): Promise<void> {
	if (ctx.mode !== "tui") {
		notify(ctx, "Workflow dashboard requires TUI mode. Use /workflow list, /workflow graph, /workflow runs, or /workflow view.", "warning");
		return;
	}
	const workflows = await listWorkflows(ctx);
	const runs = await listRuns(ctx);
	const [activity, piSessions, monitorModels, agentEntries] = await Promise.all([collectWorkflowActivity(runs), collectPiSessions(ctx), deriveWorkflowMonitorModels(runs), collectWorkflowAgents(runs)]);
	let refreshTimer: NodeJS.Timeout | undefined;
	let refreshing = false;
	let dashboard: WorkflowDashboard | undefined;
	let choice: WorkflowDashboardResult | null = null;
	try {
		choice = await ctx.ui.custom<WorkflowDashboardResult | null>((tui, theme, _keybindings, done) => {
			dashboard = new WorkflowDashboard(workflows, runs, activity, piSessions, monitorModels, agentEntries, theme, () => tui.requestRender(), done, initialTab);
			const refresh = async () => {
				if (refreshing || !dashboard) return;
				refreshing = true;
				try {
					const nextRuns = await listRuns(ctx);
					const [nextActivity, nextPiSessions, nextMonitorModels, nextAgentEntries] = await Promise.all([collectWorkflowActivity(nextRuns), collectPiSessions(ctx), deriveWorkflowMonitorModels(nextRuns), collectWorkflowAgents(nextRuns)]);
					dashboard.setRuns(nextRuns);
					dashboard.setActivity(nextActivity);
					dashboard.setPiSessions(nextPiSessions);
					dashboard.setMonitorModels(nextMonitorModels);
					dashboard.setAgentEntries(nextAgentEntries);
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
	if (choice.type === "switchSession" && choice.session) {
		await switchToPiSession(ctx, choice.session, options);
		return;
	}
	if (choice.type === "newPattern" && choice.pattern) {
		const workflow = await createWorkflowDraftFromPattern(ctx, choice.pattern);
		if (workflow) {
			notify(ctx, `Wrote ${workflow.path}\nRun it with /workflow start ${workflow.name} ${choice.pattern.inputHint}`, "info");
		}
		return;
	}
	if (choice.type === "graph") {
		const workflow = choice.workflow ?? (choice.run ? await resolveWorkflowForRun(ctx, choice.run) : undefined);
		if (!workflow) {
			notify(ctx, "Cannot open graph: workflow file not found.", "warning");
			return;
		}
		const code = await fs.readFile(workflow.path, "utf8");
		await showWorkflowGraph(ctx, workflow, code);
		return;
	}
	if (choice.type === "agent" && choice.run && choice.agent) {
		await showLiveAgentView(ctx, choice.run, choice.agent);
		return;
	}
	if (choice.type === "view" && choice.run) {
		await showText(ctx, `Workflow run: ${choice.run.runId}`, await formatRunView(choice.run));
		return;
	}
	if (choice.type === "cancel" && choice.run) {
		const ok = await ctx.ui.confirm("Cancel workflow run?", `Workflow: ${choice.run.workflow}\nRun: ${choice.run.runId}\n\nThis aborts the active background run. Artifacts already written remain on disk.`);
		if (!ok) return;
		const message = await cancelWorkflowRun(ctx, choice.run.runId);
		notify(ctx, message, "warning");
		return;
	}
	if (choice.type === "deleteRun" && choice.run) {
		if (canCancelRun(choice.run)) {
			notify(ctx, `Run is still active; cancel it before deleting artifacts: ${choice.run.runId}`, "warning");
			return;
		}
		const ok = await ctx.ui.confirm(
			"Delete workflow run artifacts?",
			`Workflow: ${choice.run.workflow}\nRun: ${choice.run.runId}\nState: ${getRunStatusLabel(choice.run)}\nDirectory: ${choice.run.runDir}\n\nThis permanently deletes this run directory and its artifacts. The workflow file is not deleted.`,
		);
		if (!ok) return;
		const message = await deleteWorkflowRun(ctx, choice.run.runId);
		notify(ctx, message, "warning");
		return;
	}
	if (choice.type === "deleteWorkflow" && choice.workflow) {
		const activeForWorkflow = [...activeRuns.values()].filter((run) => run.workflow.path === choice.workflow!.path || run.workflow.name === choice.workflow!.name);
		const ok = await ctx.ui.confirm(
			"Delete workflow?",
			`Workflow: ${choice.workflow.name}\nScope: ${choice.workflow.scope}\nPath: ${choice.workflow.path}\n\nThis deletes only the workflow file, not previous run artifacts.${activeForWorkflow.length ? `\n\nWarning: ${activeForWorkflow.length} active run(s) from this workflow will keep running unless cancelled.` : ""}`,
		);
		if (!ok) return;
		await fs.unlink(choice.workflow.path);
		notify(ctx, `Deleted workflow ${choice.workflow.name}: ${choice.workflow.path}`, "info");
		return;
	}
	if (choice.type === "rerun" && choice.run) {
		if (canCancelRun(choice.run)) {
			notify(ctx, `Run is still active; cancel or wait before rerunning: ${choice.run.runId}`, "warning");
			return;
		}
		const workflow = await resolveWorkflowForRun(ctx, choice.run);
		if (!workflow) {
			notify(ctx, "Cannot rerun: workflow file not found.", "warning");
			return;
		}
		const loaded = await loadRerunInput(ctx, choice.run);
		if (!loaded) return;
		const ok = await ctx.ui.confirm(
			"Rerun workflow?",
			`Workflow: ${workflow.name}\nFrom run: ${choice.run.runId}\nInput: ${loaded.source}\n\n${stringify(loaded.input, 1200)}`,
		);
		if (!ok) return;
		await runWorkflowFromUi(pi, ctx, workflow, loaded.input);
		return;
	}
	if (choice.type === "run" && choice.workflow) {
		const inputText = await ctx.ui.editor("Workflow input JSON", "{}");
		if (inputText === undefined) return;
		const input = parseCliJsonOrText(inputText, { strictJson: true });
		const ok = await ctx.ui.confirm("Run workflow?", `Workflow: ${choice.workflow.name}\n\n${stringify(input, 1200)}`);
		if (!ok) return;
		await runWorkflowFromUi(pi, ctx, choice.workflow, input);
	}
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
		const entry: WorkflowLogEntry = { time: new Date().toISOString(), message, ...(details === undefined ? {} : { details }) };
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
		let effectiveOptions = await applyPersonaOptions(ctx, options) as InternalAgentOptions;
		effectiveOptions = await applyDefaultAgentAccess(ctx, effectiveOptions) as InternalAgentOptions;
		if (effectiveOptions.schema !== undefined) {
			effectiveOptions = appendSystemPromptOption(effectiveOptions, makeStructuredOutputSystemPrompt(effectiveOptions.schema)) as InternalAgentOptions;
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
				const cachedPhase = phase ?? (hit.phaseIndex && hit.phaseTotal ? { id: hit.phaseId ?? 0, index: hit.phaseIndex, total: hit.phaseTotal, ...(hit.phaseLabel ? { label: hit.phaseLabel } : {}) } : undefined);
				const cachedHit: SubagentResult = {
					...hit,
					...(hit.tools?.length || !effectiveOptions.tools?.length ? {} : { tools: effectiveOptions.tools }),
					...(hit.excludeTools?.length || !effectiveOptions.excludeTools?.length ? {} : { excludeTools: effectiveOptions.excludeTools }),
					...(hit.skills?.length || !effectiveOptions.skills?.length ? {} : { skills: effectiveOptions.skills }),
					includeSkills: hit.includeSkills ?? effectiveOptions.includeSkills,
					...(hit.extensions?.length || !effectiveOptions.extensions?.length ? {} : { extensions: effectiveOptions.extensions }),
					includeExtensions: hit.includeExtensions ?? effectiveOptions.includeExtensions,
					...(hit.keys?.length || !envAccess.keyNames.length ? {} : { keys: envAccess.keyNames }),
					...(hit.missingKeys?.length || !envAccess.missingKeys.length ? {} : { missingKeys: envAccess.missingKeys }),
					isolatedEnv: hit.isolatedEnv ?? envAccess.isolatedEnv,
				};
				await appendEvent({ type: "agent", ...cachedHit, ...phaseEventFields(cachedPhase), state: "cached", promptAvailable: !!cachedHit.artifactPath, stdout: undefined, stderr: undefined, prompt: undefined });
				await log(`agent cached: ${cachedHit.name}`, { key: key.slice(0, 12), occ, artifactPath: cachedHit.artifactPath, tools: cachedHit.tools, skills: cachedHit.skills, extensions: cachedHit.extensions, keys: cachedHit.keys, missingKeys: cachedHit.missingKeys, isolatedEnv: cachedHit.isolatedEnv, ...phaseEventFields(cachedPhase) });
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
		const phaseLine = phase?.total ? `\n- phase: P${phase.id} ${phase.index}/${phase.total}${phase.label ? ` (${phase.label})` : ""}` : "";
		const preliminaryArtifact = await writeArtifact(
			artifactName,
			`# ${name}\n\n- state: running\n- startedAt: ${startedAtIso}${phaseLine}\n\n## Access\n\n${accessMarkdown}\n\n## Prompt\n\n${prompt}\n`,
		);
		const liveStdoutArtifactName = artifactName.endsWith(".md") ? artifactName.slice(0, -3) + ".stdout.log" : `${artifactName}.stdout.log`;
		const liveStderrArtifactName = artifactName.endsWith(".md") ? artifactName.slice(0, -3) + ".stderr.log" : `${artifactName}.stderr.log`;
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
			...(effectiveOptions.includeExtensions !== undefined ? { includeExtensions: effectiveOptions.includeExtensions } : {}),
			...(envAccess.keyNames.length ? { keys: envAccess.keyNames } : {}),
			...(envAccess.missingKeys.length ? { missingKeys: envAccess.missingKeys } : {}),
			isolatedEnv: envAccess.isolatedEnv,
		});
		await log(`agent ${id} start: ${name}`, { artifactPath: preliminaryArtifact.path, liveStdoutPath: liveStdoutArtifact.path, liveStderrPath: liveStderrArtifact.path, tools: effectiveOptions.tools, skills: effectiveOptions.skills, includeSkills: effectiveOptions.includeSkills, extensions: effectiveOptions.extensions, includeExtensions: effectiveOptions.includeExtensions, keys: envAccess.keyNames, missingKeys: envAccess.missingKeys, isolatedEnv: envAccess.isolatedEnv, ...phaseFields });

		function buildAgentArgs(attemptPrompt: string): string[] {
			const args = ["-p", "--no-session", "--mode", "json"];
			const explicitExtensions = effectiveOptions.extensions ?? [];
			if (effectiveOptions.includeExtensions !== true) args.push("--no-extensions");
			for (const extensionPath of explicitExtensions) args.push("--extension", extensionPath);
			const explicitSkills = effectiveOptions.skills ?? [];
			if (effectiveOptions.includeSkills === false || (explicitSkills.length > 0 && effectiveOptions.includeSkills !== true)) args.push("--no-skills");
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
			if (effectiveOptions.excludeTools?.length) args.push("--exclude-tools", effectiveOptions.excludeTools.join(","));
			if (effectiveOptions.systemPrompt) args.push("--system-prompt", effectiveOptions.systemPrompt);
			if (effectiveOptions.appendSystemPrompt) args.push("--append-system-prompt", effectiveOptions.appendSystemPrompt);
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
			if (attempt > 0) await log(`agent ${id} schema retry ${attempt}/${schemaRetries}: ${name}`, { error: schemaError });
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
			const parsedOutput = parsePiJsonModeOutput(result.stdout);
			if (!parsedOutput.ok) await log(`agent ${id} json output fallback: ${name}`, { warning: parsedOutput.warning, attempt: attempt + 1 });
			output = truncate(parsedOutput.ok ? parsedOutput.output : result.stdout.trim() || result.stderr.trim(), MAX_AGENT_OUTPUT_IN_RESULT);
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
			...(effectiveOptions.includeExtensions !== undefined ? { includeExtensions: effectiveOptions.includeExtensions } : {}),
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
		await log(`agent ${id} end: ${name}`, { ok: subagent.ok, code: subagent.code, elapsedMs, tools: subagent.tools, skills: subagent.skills, extensions: subagent.extensions, keys: subagent.keys, missingKeys: subagent.missingKeys, ...phaseFields, ...(schema === undefined ? {} : { schemaOk: subagent.schemaOk }) });
		if (schemaShouldThrow) throw new Error(`Agent ${name} did not produce valid structured output: ${schemaError || "schema validation failed"}`);
		return subagent;
	}

	// Copy of agent options excluding fields that do not affect model output, so
	// the cache key is stable across name/timeout/cache changes. prompt is also
	// dropped: it is already the first element of the cache-key array, and
	// agents() spreads a spec (which carries prompt) into options, so excluding
	// it keeps the key dependent on the prompt exactly once.
	function sanitizeAgentOpts(options: AgentOptions): Record<string, unknown> {
		const { name: _name, timeoutMs: _timeoutMs, cache: _cache, concurrency: _concurrency, settle: _settle, agentType: _agentType, __workflowPhase: _workflowPhase, env, ...rest } = options as InternalAgentOptions & {
			prompt?: string;
			concurrency?: number;
			settle?: boolean;
		};
		delete (rest as { prompt?: string }).prompt;
		return { ...rest, ...(env ? { env: sanitizeEnvForCache(env) } : {}) };
	}

	const agent = (prompt: string, options: InternalAgentOptions = {}) => trackSubagent(runSubagent(prompt, options));

	function makeRunAgents(agentRunner: (prompt: string, options?: InternalAgentOptions) => Promise<SubagentResult>): WorkflowRuntimeApi["agents"] {
		async function runAgents(items: Array<string | AgentSpec>, options: AgentOptions & { concurrency?: number; settle?: boolean } = {}): Promise<Array<SubagentResult | null>> {
			const concurrency = Math.min(Math.max(Math.floor(options.concurrency ?? runLimits.concurrency), 1), runLimits.concurrency);
			const { concurrency: _concurrency, settle = false, ...sharedOptions } = options as AgentOptions & { concurrency?: number; settle?: boolean };
			const phaseId = items.length > 0 ? ++agentPhaseCount : 0;
			const phaseLabel = typeof sharedOptions.name === "string" && sharedOptions.name.trim() ? sharedOptions.name.trim() : `agents-${phaseId}`;
			const runItem = async (item: string | AgentSpec, index: number): Promise<SubagentResult> => {
				const __workflowPhase: AgentPhaseInfo = { id: phaseId, index: index + 1, total: items.length, label: phaseLabel };
				if (typeof item === "string") return await agentRunner(item, { ...sharedOptions, __workflowPhase, name: sharedOptions.name ?? `agent-${index + 1}` } as InternalAgentOptions);
				const { prompt: itemPrompt, ...itemOptions } = item;
				return await agentRunner(itemPrompt, { ...sharedOptions, ...itemOptions, __workflowPhase, name: item.name ?? `agent-${index + 1}` } as InternalAgentOptions);
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
		const key = computeCallKey("bash", [command, { cwd: options.cwd ?? ctx.cwd, ...(options.__workflowNamespace ? { workflowNamespace: options.__workflowNamespace } : {}) }]);
		const occ = nextOcc(key);
		if (cacheEnabled) {
			const hit = journalLookup(key, occ) as BashResult | undefined;
			if (hit && !("artifactPath" in hit)) {
				cachedCalls++;
				await log(`bash cached: ${command.slice(0, 80)}`, { key: key.slice(0, 12), occ, ...(options.__workflowNamespace ? { workflowNamespace: options.__workflowNamespace } : {}) });
				if (options.throwOnError && !hit.ok) {
					throw new Error(`Command failed (${hit.code}): ${command}\n${hit.stderr || hit.stdout}`);
				}
				return hit;
			}
		}
		const startedAt = Date.now();
		await log(`bash start: ${command.slice(0, 120)}`, options.__workflowNamespace ? { workflowNamespace: options.__workflowNamespace } : undefined);
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
		await appendEvent({ type: "bash", command, ...bashResult, ...(options.__workflowNamespace ? { workflowNamespace: options.__workflowNamespace } : {}) });
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
		await log(`bash end: ${command.slice(0, 120)}`, { ok: bashResult.ok, code: bashResult.code, ...(options.__workflowNamespace ? { workflowNamespace: options.__workflowNamespace } : {}) });
		if (options.throwOnError && !bashResult.ok) {
			throw new Error(`Command failed (${bashResult.code}): ${command}\n${bashResult.stderr || bashResult.stdout}`);
		}
		return bashResult;
	}

	async function runSubworkflow(name: string, workflowInput: unknown = {}): Promise<unknown> {
		throwIfAborted(runSignal.signal);
		const subWorkflow = await resolveWorkflow(ctx, name, "auto");
		if (path.resolve(subWorkflow.path) === path.resolve(workflowFile.path)) {
			throw new Error(`ctx.workflow() refused recursive call to ${subWorkflow.name}. Sub-workflows are depth-1 and may not call their parent.`);
		}
		const subCode = await fs.readFile(subWorkflow.path, "utf8");
		const subCodeHash = computeCodeHash(subCode);
		const workflowCallKey = computeCallKey("workflow", [subWorkflow.name, workflowInput]);
		const workflowOcc = nextOcc(workflowCallKey);
		const namespace = `workflow:${subWorkflow.name}:${subCodeHash.slice(0, 12)}:${workflowOcc}`;
		await appendEvent({ type: "workflow", phase: "start", name: subWorkflow.name, file: subWorkflow.path, namespace, occ: workflowOcc });
		await log(`sub-workflow start: ${subWorkflow.name}`, { file: subWorkflow.path, namespace, occ: workflowOcc, remainingAgents: Math.max(0, runLimits.maxAgents - agentCount) });
		try {
			const result = await executeWorkflowCode(subWorkflow, subCode, makeApi(namespace, false, workflowInput), workflowInput, runLimits, runSignal.signal);
			await appendEvent({ type: "workflow", phase: "end", name: subWorkflow.name, namespace, occ: workflowOcc, ok: true });
			await log(`sub-workflow end: ${subWorkflow.name}`, { namespace, occ: workflowOcc, remainingAgents: Math.max(0, runLimits.maxAgents - agentCount) });
			return result;
		} catch (err) {
			const message = err instanceof Error ? err.stack || err.message : String(err);
			await appendEvent({ type: "workflow", phase: "error", name: subWorkflow.name, namespace, occ: workflowOcc, ok: false, error: message });
			await log(`sub-workflow failed: ${subWorkflow.name}`, { namespace, occ: workflowOcc, error: message });
			throw err;
		}
	}

	function makeApi(workflowNamespace: string | undefined, allowWorkflow: boolean, apiInput: unknown): WorkflowRuntimeApi {
		const namespacedAgent = (prompt: string, options: InternalAgentOptions = {}) => agent(prompt, { ...options, ...(workflowNamespace ? { __workflowNamespace: workflowNamespace } : {}) });
		return {
			cwd: ctx.cwd,
			runId,
			runDir,
			input: apiInput,
			limits: runLimits,
			log,
			agent: namespacedAgent,
			agents: makeRunAgents(namespacedAgent),
			workflow: allowWorkflow ? runSubworkflow : async () => {
				throw new Error("ctx.workflow() composition depth limit is 1: sub-workflows cannot call other sub-workflows.");
			},
			bash: async (command, options = {}) => await runBash(command, { ...options, ...(workflowNamespace ? { __workflowNamespace: workflowNamespace } : {}) }),
			readFile: async (filePath, encoding = "utf8") => await fs.readFile(resolveCwdPath(ctx.cwd, filePath), encoding),
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
		await log(`workflow start: ${workflowFile.name}`, { file: workflowFile.path, runDir, ...(resumedFrom ? { resumedFrom } : {}) });
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
	const resultState: Exclude<WorkflowRunState, "running" | "stale"> = state === "completed" || state === "cancelled" ? state : "failed";
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
	await writeRunStatus({ ...makeStatus(resultState, ended), ...(output === undefined ? {} : { output }), ...(error === undefined ? {} : { error }) });
	await fs.writeFile(path.join(runDir, "summary.md"), formatRunSummary(result), "utf8");
	return result;
}

function initialRunStatus(workflow: WorkflowFile, prepared: PreparedWorkflowRun, active: boolean, limits?: RunLimits): WorkflowRunStatus {
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
		...(limits ? { agentConcurrency: limits.concurrency, maxAgents: limits.maxAgents, parallelAgents: 0, peakParallelAgents: prepared.resume?.previousPeakParallelAgents ?? 0 } : {}),
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
		throw new Error("Background workflow runs require a persistent TUI/RPC session. In print/json mode, action=run falls back to foreground because there is no live session to keep a background run alive.");
	}
	// For resume, preparedRun reuses the existing runDir/runId in place.
	const prepared = preparedRun ?? (await prepareWorkflowRun(ctx, workflow.name, true));
	const controller = new AbortController();
	const active: ActiveWorkflowRun = { runId: prepared.runId, runDir: prepared.runDir, started: prepared.started, workflow, controller };
	activeRuns.set(prepared.runId, active);
	const status = initialRunStatus(workflow, prepared, true, limits);
	await writeRunStatus(status);
	refreshActiveWorkflowStatus(ctx);

	const promise = runWorkflow(pi, ctx, workflow, input, limits, controller.signal, undefined, prepared)
		.then((result) => {
			const resultState = getRunState(result);
			const type = resultState === "completed" ? "info" : resultState === "cancelled" ? "warning" : "error";
			notify(ctx, `Background workflow ${getRunStatusLabel(result)}: ${workflow.name}\nRun: ${result.runId}\nArtifacts: ${result.runDir}`, type);
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
			await writeRunStatus({ ...initialRunStatus(workflow, prepared, false, limits), state: "failed", endedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), elapsedMs: now - prepared.started, error });
			await fs.writeFile(path.join(prepared.runDir, "summary.md"), formatRunSummary(result), "utf8");
			notify(ctx, `Background workflow failed to run: ${workflow.name}\nRun: ${prepared.runId}\nError: ${error}`, "error");
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
	const resumable = state === "stale" || state === "failed" || state === "cancelled" || (opts.force === true && state === "completed");
	if (!resumable) {
		if (state === "running") throw new Error(`Workflow run ${record.runId} is still running. Cancel it before resuming.`);
		if (state === "completed") throw new Error(`Workflow run ${record.runId} already completed. Use force:true to resume it anyway.`);
		throw new Error(`Workflow run ${record.runId} cannot be resumed (state: ${state}).`);
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
		started: Number.isFinite(new Date(record.startedAt).getTime()) ? new Date(record.startedAt).getTime() : Date.now(),
		runId: record.runId,
		runDir: record.runDir,
		background: resumeInBackground,
		resume: { journal, baseAgentCount, codeHash, resumedFrom: record.runId, previousPeakParallelAgents: getRunPeakParallelAgents(record) ?? 0 },
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
	return activeRuns.get(key) ?? runs.find((run) => run.runId.includes(key) || run.workflow.name === key);
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

async function resolveRunForDeletion(ctx: ExtensionContext, id: string | undefined): Promise<{ run: WorkflowRunRecord; runDir: string }> {
	const dirs = await getRunDirs(ctx);
	const records: Array<{ run: WorkflowRunRecord; runDir: string }> = [];
	for (const runDir of dirs) {
		const run = await readRunRecord(runDir);
		if (run) records.push({ run, runDir });
	}
	if (records.length === 0) throw new Error("No workflow runs found.");
	const key = id?.trim() || "latest";
	if (key === "latest") return records[0]!;
	const found = records.find(({ run }) => run.runId === key || run.runId.includes(key) || run.workflow === key);
	if (!found) throw new Error(`Workflow run not found: ${key}`);
	return found;
}

async function deleteWorkflowRun(ctx: ExtensionContext, id: string | undefined): Promise<string> {
	const { run, runDir } = await resolveRunForDeletion(ctx, id);
	if (activeRuns.has(run.runId)) throw new Error(`Workflow run is active; cancel it before deleting artifacts: ${run.runId}`);
	await fs.rm(runDir, { recursive: true, force: false });
	return `Deleted workflow run artifacts: ${run.runId}\nDirectory: ${runDir}`;
}

async function abortActiveWorkflowRuns(reason: string): Promise<void> {
	const promises = [...activeRuns.values()].map((run) => {
		run.controller.abort(reason);
		return run.promise;
	}).filter((promise): promise is Promise<WorkflowRunResult> => promise !== undefined);
	if (promises.length === 0) return;
	await Promise.race([Promise.allSettled(promises), new Promise((resolve) => setTimeout(resolve, 3000))]);
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
			throw new Error(`Unknown workflow pattern: ${params.name}. Available: ${WORKFLOW_PATTERN_CATALOG.map((item) => item.key).join(", ")}`);
		}
		if (pattern) {
			const template = await loadWorkflowPatternCode(pattern);
			return { content: [text(template)], details: { action, pattern, template } };
		}
		return { content: [text(formatWorkflowPatternCatalog())], details: { action, patterns: WORKFLOW_PATTERN_CATALOG, template: WORKFLOW_TEMPLATE } };
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
				const preview = logs.slice(-8).map((entry) => `${entry.time.slice(11, 19)} ${entry.message}`).join("\n");
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
		return { content: [text(`Deleted workflow ${workflow.name} (${workflow.scope}) from ${workflow.path}`)], details: { action, workflow } };
	}

	if (action === "start" || (action === "run" && shouldLaunchWorkflowInBackground(ctx))) {
		const workflow = await resolveWorkflow(ctx, params.name, scope);
		const workflowInput = params.input ?? {};
		const limits = buildLimits({ ...limitParamsFromInput(workflowInput), ...params });
		const status = await startWorkflowBackground(pi, ctx, workflow, workflowInput, limits);
		return { content: [text(formatBackgroundStart(status))], details: { action, workflow, status } };
	}

	if (action === "run") {
		const workflow = await resolveWorkflow(ctx, params.name, scope);
		const workflowInput = params.input ?? {};
		const limits = buildLimits({ ...limitParamsFromInput(workflowInput), ...params });
		const result = await runWorkflowWithUi(pi, ctx, workflow, workflowInput, limits, signal, (logs) => {
			const preview = logs.slice(-8).map((entry) => `${entry.time.slice(11, 19)} ${entry.message}`).join("\n");
			onUpdate?.({ content: [text(preview)], details: { action, workflow, logCount: logs.length } });
		});
		if (!result.ok) throw new Error(formatRunSummary(result));
		return { content: [text(formatRunSummary(result))], details: { action, workflow, result } };
	}

	throw new Error(`Unknown dynamic_workflow action: ${action}`);
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
			const session = sessions.find((item) => item.sessionFile && path.resolve(item.sessionFile) === resolvedSessionFile) ?? {
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
				notify(ctx, "/workflow new requires interactive UI. Use dynamic_workflow action=write in agent mode.", "warning");
				return;
			}
			const patternKey = parsePatternFlag(trailingText);
			const pattern = patternKey ? resolveWorkflowPattern(patternKey) : undefined;
			if (patternKey && !pattern) {
				notify(ctx, `Unknown workflow pattern: ${patternKey}. Available: ${WORKFLOW_PATTERN_CATALOG.map((item) => item.key).join(", ")}`, "warning");
				return;
			}
			const template = pattern ? await loadWorkflowPatternCode(pattern) : WORKFLOW_TEMPLATE;
			const edited = await ctx.ui.editor(pattern ? `New workflow: ${name} (${pattern.key})` : `New workflow: ${name}`, template);
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
				notify(ctx, "/workflow delete-run requires interactive confirmation; refusing in no-UI mode.", "warning");
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

		notify(ctx, "Usage: /workflow list | dashboard | agents | sessions | patterns | graph <name> | runs | view [latest|runId] | new <name> [--pattern=<key>] | edit <name> | run <name> [json] | start <name> [json] | resume [latest|runId] [--force] | cancel [latest|runId] | delete-run [latest|runId] | delete <name>", "warning");
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

function makeUltracodePrompt(task: string, mode: "ultracode" | "deep-research" = "ultracode"): string {
	const trimmed = task.trim();
	const header =
		mode === "deep-research"
			? "Use Pi Dynamic Workflows for a source-backed deep-research investigation."
			: "Use Pi Dynamic Workflows when they are warranted for this task.";
	return `${header}

Task:
${trimmed}

Ultracode rules:

Decision gates:
- Ambiguity: if it blocks routing or implementation, infer concise success criteria when safe; ask only blocking questions.
- Trivial: solve conversational, single-step, or few-tool-call tasks directly; do not build a workflow.
- Scout: if the task may be broad, probe cheaply inline to discover the real work-list.
- Orchestrate: use a workflow only for exhaustiveness, confidence, or scale.

Workflow path:
- Inspect the template catalog before writing code.
- Reuse an existing workflow only on an exact task match; otherwise write a gitignored .pi/workflows/drafts/<slug>.js draft.
- Graph/start background runs with explicit concurrency/maxAgents, then inspect artifacts.
- Use workflow-factory only when a warranted workflow needs complex prompt/contract design.
- Scale concurrency/maxAgents to the discovered work-list and risk; log caps, clamps, skipped work, and failures.
- For audits/research, keep subagents read-only and synthesize only evidence-backed findings.
- When drafting workflow code, remember subagents get web_search via pi-codex-web-search and context7-cli when installed; do not opt out unless the task requires isolation.

Reference:
- ${formatWorkflowPatternKeyList()}
- ${formatWorkflowCompositionPromptSummary()}`;
}

function makeAlwaysOnUltracodeSystemPrompt(): string {
	return `## Always-on Ultracode Router

For substantive tasks, choose the lightest path that can verify the answer.

Decision gates:
- Ambiguity: if it blocks routing or implementation, infer concise success criteria when safe; ask only blocking questions.
- Trivial: conversational, single-step, or few-tool-call tasks stay single-agent.
- Scout: broad-looking tasks get a cheap inline probe first (git ls-files, diff, rg/glob).
- Orchestrate: use dynamic_workflow only for exhaustiveness, confidence, or scale.

Workflow path:
- Inspect the catalog, then reuse an exact existing fit or write a gitignored .pi/workflows/drafts/<slug>.js draft.
- Graph/start in background with explicit concurrency/maxAgents, then inspect artifacts.
- Scale parallelism to the work-list and risk; log caps, clamps, skipped work, and failed branches.
- Use workflow-factory only when a warranted workflow needs complex prompt/contract design.
- When drafting workflow code, remember subagents get web_search via pi-codex-web-search and context7-cli when installed; do not opt out unless the task requires isolation.

Reference:
- ${formatWorkflowPatternKeyList()}
- ${formatWorkflowCompositionPromptSummary()}

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

function extractUltracodeTask(textValue: string): string | undefined {
	const trimmed = textValue.trim();
	const match = /^(?:ultracode|dynamic\s+workflow)\s*[:\-]?\s+([\s\S]+)/i.exec(trimmed);
	return match?.[1]?.trim();
}

function isGeneratedUltracodePrompt(prompt: string): boolean {
	return prompt.includes("\nUltracode rules:\n");
}

function sendWorkflowPrompt(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string): void {
	if (ctx.isIdle()) pi.sendUserMessage(prompt);
	else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

export default function dynamicWorkflowsExtension(pi: ExtensionAPI): void {
	let ultracodeAlwaysOn = true;
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
			return await handleTool(pi, params as DynamicWorkflowToolParams, signal, onUpdate, ctx);
		},
	});

	pi.registerCommand("workflow", {
		description: "Manage dynamic workflows: /workflow list|dashboard|agents|sessions|patterns|graph|runs|view|new|edit|run|start|resume|cancel|delete-run|delete",
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
			if (!ensureDynamicWorkflowToolActive(pi)) notify(ctx, "dynamic_workflow tool is not active; ultracode will only provide routing guidance.", "warning");
			sendWorkflowPrompt(pi, ctx, makeUltracodePrompt(task, "ultracode"));
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
			if (!ensureDynamicWorkflowToolActive(pi)) notify(ctx, "dynamic_workflow tool is not active; deep-research will only provide routing guidance.", "warning");
			sendWorkflowPrompt(pi, ctx, makeUltracodePrompt(task, "deep-research"));
		},
	});

	pi.registerCommand("ultracode-mode", {
		description: "Show or toggle always-on ultracode workflow routing for this session",
		handler: async (args, ctx) => {
			const value = args.trim().toLowerCase();
			if (!value || value === "status") {
				setUltracodeStatus(ctx, ultracodeAlwaysOn);
				notify(ctx, `Ultracode always-on is ${ultracodeAlwaysOn ? "enabled" : "disabled"}.`, "info");
				return;
			}
			if (["on", "enable", "enabled", "true", "1"].includes(value)) {
				ultracodeAlwaysOn = true;
				ensureDynamicWorkflowToolActive(pi);
				setUltracodeStatus(ctx, ultracodeAlwaysOn);
				notify(ctx, "Ultracode always-on enabled: Pi will evaluate each task for workflow routing.", "info");
				return;
			}
			if (["off", "disable", "disabled", "false", "0"].includes(value)) {
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
		return { action: "transform" as const, text: makeUltracodePrompt(task, "ultracode"), images: event.images };
	});

	pi.on("before_agent_start", async (event) => {
		if (!ultracodeAlwaysOn) return;
		if (isGeneratedUltracodePrompt(event.prompt)) return;
		if (!dynamicWorkflowToolAvailable(event.systemPromptOptions.selectedTools) && !ensureDynamicWorkflowToolActive(pi)) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${makeAlwaysOnUltracodeSystemPrompt()}`,
		};
	});

	pi.on("session_start", async (event, ctx) => {
		currentCtx = ctx;
		await startPiSessionHeartbeat(event, ctx);
		installWorkflowDashboardDownEditor(pi, ctx);
		if (ultracodeAlwaysOn) ensureDynamicWorkflowToolActive(pi);
		refreshActiveWorkflowStatus(ctx);
		setUltracodeStatus(ctx, ultracodeAlwaysOn);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await stopPiSessionHeartbeat();
		await abortActiveWorkflowRuns("Workflow cancelled by session shutdown.");
		clearWorkflowWidget(ctx);
		setWorkflowIdleStatus(ctx);
		clearUltracodeStatus(ctx);
		currentCtx = undefined;
	});
}
