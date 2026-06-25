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
	getAgentDir,
	type AgentToolUpdateCallback,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import * as crypto from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Worker } from "node:worker_threads";

const WORKFLOW_DIR = "workflows";
const WORKFLOW_RUN_DIR = "workflow-runs";
const DEFAULT_MAX_AGENTS = 64;
const HARD_MAX_AGENTS = 1000;
const DEFAULT_CONCURRENCY = 4;
const HARD_MAX_CONCURRENCY = 16;
const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_WORKFLOW_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_SYNC_TIMEOUT_MS = 5_000;
const MAX_TOOL_TEXT = 24_000;
const MAX_AGENT_OUTPUT_IN_RESULT = 24_000;
const WORKFLOW_STATUS_KEY = "dynamic-workflows";
const WORKFLOW_WIDGET_KEY = "dynamic-workflows";
const ULTRACODE_STATUS_KEY = "dynamic-workflows-ultracode";

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
}

interface RunLimits {
	concurrency: number;
	maxAgents: number;
	timeoutMs: number;
	agentTimeoutMs: number;
	syncTimeoutMs: number;
}

interface AgentOptions {
	name?: string;
	cwd?: string;
	tools?: string[];
	excludeTools?: string[];
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

interface AgentSpec extends AgentOptions {
	prompt: string;
}

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
	"model",
	"provider",
	"thinking",
	"includeExtensions",
	"approve",
	"useContextFiles",
	"systemPrompt",
	"appendSystemPrompt",
	"timeoutMs",
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
	bash(command: string, options?: { cwd?: string; timeoutMs?: number; throwOnError?: boolean; cache?: boolean }): Promise<BashResult>;
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
			"Workflow operation to perform: list/template/read/write/run/start/resume/cancel/delete/graph/runs/view. resume re-runs an interrupted run (stale/failed/cancelled) in place, reusing cached completed subagent/bash calls so they are not re-executed.",
	}),
	name: Type.Optional(
		Type.String({
			description: "Workflow name/path relative to the workflow directory (.js is added when omitted), or run id for view/cancel/resume (defaults to latest for resume).",
		}),
	),
	scope: Type.Optional(
		StringEnum(WORKFLOW_SCOPE_INPUTS, {
			description: "Use project .pi/workflows, global ~/.pi/agent/workflows, or auto resolution.",
		}),
	),
	code: Type.Optional(Type.String({ description: "JavaScript workflow source for action=write." })),
	input: Type.Optional(Type.Any({ description: "JSON-serializable input passed to action=run/start workflow(ctx, input)." })),
	background: Type.Optional(Type.Boolean({ description: "For action=run/resume, start the workflow in the background and return immediately." })),
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

const WORKFLOW_TEMPLATE = [
	"/**",
	" * Pi Dynamic Workflow",
	" *",
	" * Export a function: async function workflow(ctx, input) { ... }",
	" *",
	" * Useful ctx helpers:",
	" * - ctx.agent(prompt, opts)        Run one Pi subagent; opts can include schema or agentType",
	" * - ctx.agents([...], opts)        Run many subagents with bounded concurrency; add {settle:true} for null-on-failure",
	" * - ctx.pipeline(items, ...stages) Multi-stage per-item flow without global barriers; failed items return null",
	" * - ctx.parallel([...thunks])      Run async branches with a barrier; failed branches return null",
	" * - ctx.bash(command, opts)        Run a shell command",
	" * - ctx.readFile/writeFile(...)    File helpers relative to the project cwd",
	" * - ctx.writeArtifact(name, data)  Persist intermediate state under ctx.runDir",
	" * - ctx.log(message, details)      Stream progress to Pi and events.jsonl",
	" */",
	"",
	"module.exports = async function workflow(ctx, input) {",
	"  await ctx.log(\"Starting workflow\", { input });",
	"",
	"  const files = await ctx.bash(\"git ls-files | head -200\");",
	"  const candidates = files.stdout",
	"    .split(\"\\n\")",
	"    .filter(Boolean)",
	"    .filter((file) => /\\.(ts|tsx|js|jsx|py|go|rs)$/.test(file))",
	"    .slice(0, input?.limit ?? 12);",
	"",
	"  const reviews = await ctx.agents(",
	"    candidates.map((file) => ({",
	"      name: `review-${file}`,",
	"      prompt: `Review ${file} for likely bugs or risky code. Be concise and cite line numbers when possible.`,",
	"      tools: [\"read\", \"grep\", \"find\", \"ls\"],",
	"    })),",
	"    { concurrency: Math.min(input?.concurrency ?? ctx.limits.concurrency, ctx.limits.concurrency) },",
	"  );",
	"",
	"  await ctx.writeArtifact(\"reviews.json\", reviews);",
	"",
	"  const synthesis = await ctx.agent(",
	"    `Synthesize these review outputs into prioritized findings.\\n\\n${ctx.compact(reviews, 50000)}`,",
	"    { name: \"synthesis\", tools: [\"read\", \"grep\", \"find\", \"ls\"] },",
	"  );",
	"",
	"  return synthesis.output;",
	"};",
	"",
].join("\n");

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
	const lines = stdout.split(/\r?\n/).filter((line) => line.trim());
	if (lines.length === 0) return { ok: false, warning: "empty JSON event stream" };
	let lastAssistantText: string | undefined;
	for (let i = 0; i < lines.length; i++) {
		let event: unknown;
		try {
			event = JSON.parse(lines[i]!);
		} catch (err) {
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
	if (lastAssistantText === undefined) return { ok: false, warning: "no assistant text found in JSON event stream" };
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
			root: path.join(ctx.cwd, CONFIG_DIR_NAME, WORKFLOW_DIR),
			trusted: ctx.isProjectTrusted(),
		},
		{
			scope: "global",
			root: path.join(getAgentDir(), WORKFLOW_DIR),
			trusted: true,
		},
	];
}

function getRunRoot(ctx: ExtensionContext): string {
	if (ctx.isProjectTrusted()) return path.join(ctx.cwd, CONFIG_DIR_NAME, WORKFLOW_RUN_DIR);
	const projectHash = crypto.createHash("sha1").update(ctx.cwd).digest("hex").slice(0, 12);
	return path.join(getAgentDir(), WORKFLOW_RUN_DIR, projectHash);
}

function requireTrustedProject(ctx: ExtensionContext): void {
	if (!ctx.isProjectTrusted()) {
		throw new Error(`Project workflows require a trusted project. Run /trust or use scope=global.`);
	}
}

async function ensureDir(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
}

async function walkWorkflowFiles(root: string): Promise<string[]> {
	if (!existsSync(root)) return [];
	const out: string[] = [];
	async function walk(dir: string): Promise<void> {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
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
		for (const file of await walkWorkflowFiles(location.root)) {
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
	forWrite = false,
): Promise<WorkflowFile> {
	const relativePath = normalizeWorkflowName(name);
	const locations = getLocations(ctx);

	if (forWrite) {
		const targetScope: WorkflowScope = scope === "global" ? "global" : "project";
		if (targetScope === "project") requireTrustedProject(ctx);
		const location = locations.find((loc) => loc.scope === targetScope)!;
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

function workflowProgress(logs: WorkflowLogEntry[]): { agentsStarted: number; agentsDone: number; bashDone: number } {
	let agentsStarted = 0;
	let agentsDone = 0;
	let bashDone = 0;
	for (const logEntry of logs) {
		if (/^agent \d+ start:/.test(logEntry.message)) agentsStarted++;
		if (/^agent \d+ end:/.test(logEntry.message)) agentsDone++;
		if (/^bash end:/.test(logEntry.message)) bashDone++;
	}
	return { agentsStarted, agentsDone, bashDone };
}

function workflowDashboardHint(): string {
	return "/workflows ↑↓";
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

function setWorkflowIdleStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(WORKFLOW_STATUS_KEY, ctx.ui.theme.fg("dim", "wf"));
}

function setWorkflowRunningStatus(ctx: ExtensionContext, workflowName: string, logs: WorkflowLogEntry[]): void {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	const { agentsStarted, agentsDone, bashDone } = workflowProgress(logs);
	const progress = agentsStarted > 0 ? ` ${agentsDone}/${agentsStarted}` : "";
	const bash = bashDone > 0 ? ` bash:${bashDone}` : "";
	ctx.ui.setStatus(
		WORKFLOW_STATUS_KEY,
		`${theme.fg("accent", "▶ wf")} ${theme.fg("dim", shortWorkflowName(workflowName))}${theme.fg("accent", progress)}${theme.fg("dim", `${bash} ${workflowDashboardHint()}`)}`,
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

function formatLiveRunView(logs: WorkflowLogEntry[], workflowName: string, width = 80): string[] {
	const w = Math.max(1, width);
	const { agentsStarted, agentsDone, bashDone } = workflowProgress(logs);
	const latest = logs.slice(-1)[0];
	const line = (s: string) => truncateToWidth(s, w, "");
	return [
		line(`▶ wf ${shortWorkflowName(workflowName)}  agents ${agentsDone}/${agentsStarted}  bash ${bashDone}  logs ${logs.length}`),
		line(latest ? `${latest.time.slice(11, 19)} ${latest.message}  •  ${workflowDashboardHint()}` : `Open monitor: ${workflowDashboardHint()}`),
	];
}

function setWorkflowWidget(ctx: ExtensionContext, workflowName: string, logs: WorkflowLogEntry[]): void {
	if (!ctx.hasUI) return;
	if (ctx.mode !== "tui") {
		ctx.ui.setWidget(WORKFLOW_WIDGET_KEY, formatLiveRunView(logs, workflowName), { placement: "belowEditor" });
		return;
	}
	ctx.ui.setWidget(
		WORKFLOW_WIDGET_KEY,
		() => ({
			invalidate(): void {},
			render(width: number): string[] {
				return formatLiveRunView(logs, workflowName, width);
			},
		}),
		{ placement: "belowEditor" },
	);
}

function mermaidLabel(value: string): string {
	return value.replace(/["<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 90) || "step";
}

function extractFirstStringLiteral(source: string): string | undefined {
	const match = /(?:`([^`]{1,120})`|"([^"\n]{1,120})"|'([^'\n]{1,120})')/.exec(source);
	return match?.[1] ?? match?.[2] ?? match?.[3];
}

function makeWorkflowGraph(workflow: WorkflowFile, code: string): string {
	const stepTypes: Record<string, string> = {
		agents: "parallel subagents",
		agent: "subagent",
		bash: "bash",
		writeArtifact: "write artifact",
		appendArtifact: "append artifact",
		readFile: "read file",
		writeFile: "write file",
		appendFile: "append file",
		listFiles: "list files",
	};
	const regex = /ctx\.(agents|agent|bash|writeArtifact|appendArtifact|readFile|writeFile|appendFile|listFiles)\s*\(/g;
	const steps: Array<{ method: string; label: string }> = [];
	let match: RegExpExecArray | null;
	while ((match = regex.exec(code)) !== null) {
		const method = match[1]!;
		const snippet = code.slice(match.index, match.index + 240);
		const firstArg = extractFirstStringLiteral(snippet);
		steps.push({ method, label: `${stepTypes[method] ?? method}${firstArg ? `: ${mermaidLabel(firstArg)}` : ""}` });
	}

	const lines = [
		`# Workflow graph: ${workflow.name}`,
		"",
		"> Heuristic static graph inferred from `ctx.*` calls. Dynamic loops/branches are approximate.",
		"",
		"```mermaid",
		"flowchart TD",
		`  start([${mermaidLabel(workflow.name)}])`,
	];
	if (steps.length === 0) {
		lines.push("  start --> done([done])");
	} else {
		for (let i = 0; i < steps.length; i++) {
			const id = `s${i + 1}`;
			const shape = steps[i]!.method === "agents" ? `{{${mermaidLabel(steps[i]!.label)}}}` : `["${mermaidLabel(steps[i]!.label)}"]`;
			lines.push(`  ${id}${shape}`);
			lines.push(`  ${i === 0 ? "start" : `s${i}`} --> ${id}`);
		}
		lines.push(`  s${steps.length} --> done([done])`);
	}
	lines.push("```", "", "## Detected steps", "");
	if (steps.length === 0) lines.push("No `ctx.*` workflow API calls detected.");
	else steps.forEach((step, index) => lines.push(`${index + 1}. ${step.label}`));
	return lines.join("\n");
}

async function getRunDirs(ctx: ExtensionContext): Promise<string[]> {
	const root = getRunRoot(ctx);
	if (!existsSync(root)) return [];
	const entries = await fs.readdir(root, { withFileTypes: true });
	const dirs = await Promise.all(
		entries
			.filter((entry) => entry.isDirectory())
			.map(async (entry) => {
				const full = path.join(root, entry.name);
				const stat = await fs.stat(full);
				return { full, mtimeMs: stat.mtimeMs };
			}),
	);
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

async function readRunLogEvents(runDir: string): Promise<WorkflowLogEntry[]> {
	try {
		const body = await fs.readFile(path.join(runDir, "events.jsonl"), "utf8");
		const logs: WorkflowLogEntry[] = [];
		for (const line of body.split("\n")) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line) as { type?: string; time?: string; message?: string; details?: unknown };
				if (event.type === "log" && event.time && event.message) {
					logs.push({ time: event.time, message: event.message, ...(event.details === undefined ? {} : { details: event.details }) });
				}
			} catch {
				// Ignore malformed event lines.
			}
		}
		return logs;
	} catch {
		return [];
	}
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
			return `${getRunStatusIcon(run)} ${run.runId} — ${run.workflow}${bg} — ${getRunStatusLabel(run)}${active}${resumable} — ${Math.round(run.elapsedMs / 1000)}s — agents ${run.agentCount}${cached}`;
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
	const started = new Date(run.startedAt).getTime();
	const logs = getRunLogs(run).length > 0 ? getRunLogs(run) : await readRunLogEvents(run.runDir);
	const timeline = logs.map((entry) => {
		const elapsed = Math.max(0, new Date(entry.time).getTime() - started);
		const seconds = (elapsed / 1000).toFixed(1).padStart(5, " ");
		return `+${seconds}s ${entry.message}${entry.details === undefined ? "" : ` — ${stringify(entry.details, 500)}`}`;
	});
	const state = getRunState(run);
	const statusEmoji = state === "completed" ? "✅" : state === "running" ? "▶️" : state === "cancelled" ? "🟨" : state === "stale" ? "⚠️" : "❌";
	const cachedCalls = getRunCachedCalls(run);
	const resumable = isResumableState(state);

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

interface WorkflowDashboardResult {
	type: "graph" | "run" | "view" | "cancel" | "rerun";
	workflow?: WorkflowFile;
	run?: WorkflowRunRecord;
}

interface WorkflowActivityEntry {
	time: string;
	workflow: string;
	runId: string;
	state: WorkflowRunState;
	message: string;
	details?: unknown;
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
	bashDone: number;
	artifactCount: number;
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
	const logs = getRunLogs(run).length > 0 ? getRunLogs(run) : await readRunLogEvents(run.runDir);
	const { agentsStarted, agentsDone, bashDone } = workflowProgress(logs);
	const active = isActiveRunRecord(run);
	const lastLog = logs.slice(-1)[0];
	return {
		run,
		workflow: run.workflow,
		runId: run.runId,
		state,
		active,
		stale: state === "stale" || (state === "running" && !active),
		elapsedMs: getRunElapsedMs(run, state),
		agentsStarted: Math.max(agentsStarted, run.agentCount),
		agentsDone,
		bashDone,
		artifactCount: await countRunArtifacts(run.runDir),
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

class WorkflowDashboard {
	private tab: "monitor" | "runs" | "workflows" | "activity" = "monitor";
	private workflowIndex = 0;
	private runIndex = 0;
	private activityIndex = 0;

	constructor(
		private readonly workflows: WorkflowFile[],
		private runs: WorkflowRunRecord[],
		private activity: WorkflowActivityEntry[],
		private monitorModels: WorkflowMonitorModel[],
		private readonly theme: any,
		private readonly requestRender: () => void,
		private readonly done: (result: WorkflowDashboardResult | null) => void,
	) {}

	setRuns(runs: WorkflowRunRecord[]): void {
		this.runs = runs;
		this.runIndex = Math.min(this.runIndex, Math.max(0, runs.length - 1));
	}

	setActivity(activity: WorkflowActivityEntry[]): void {
		this.activity = activity;
		this.activityIndex = Math.min(this.activityIndex, Math.max(0, activity.length - 1));
	}

	setMonitorModels(models: WorkflowMonitorModel[]): void {
		this.monitorModels = models;
	}

	invalidate(): void {}

	private selectedMonitor(): WorkflowMonitorModel | undefined {
		return this.monitorModels.find((model) => model.active) ?? this.monitorModels[0];
	}

	private selectedRun(): WorkflowRunRecord | undefined {
		if (this.tab === "monitor") return this.selectedMonitor()?.run;
		if (this.tab === "runs") return this.runs[this.runIndex];
		if (this.tab === "activity") {
			const entry = this.activity[this.activityIndex];
			return entry ? this.runs.find((candidate) => candidate.runId === entry.runId) : undefined;
		}
		return undefined;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.done(null);
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.tab = this.tab === "monitor" ? "runs" : this.tab === "runs" ? "workflows" : this.tab === "workflows" ? "activity" : "monitor";
			this.requestRender();
			return;
		}
		if (data === "m") {
			this.tab = "monitor";
			this.requestRender();
			return;
		}
		if (data === "a") {
			this.tab = "activity";
			this.requestRender();
			return;
		}
		if (data === "w") {
			this.tab = "workflows";
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.up)) {
			if (this.tab === "workflows") this.workflowIndex = Math.max(0, this.workflowIndex - 1);
			else if (this.tab === "runs") this.runIndex = Math.max(0, this.runIndex - 1);
			else if (this.tab === "activity") this.activityIndex = Math.max(0, this.activityIndex - 1);
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			if (this.tab === "workflows") this.workflowIndex = Math.min(Math.max(0, this.workflows.length - 1), this.workflowIndex + 1);
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
			return;
		}
		const run = this.selectedRun();
		if (!run) return;
		if (matchesKey(data, Key.enter) || data === "v") this.done({ type: "view", run });
		else if (data === "g") this.done({ type: "graph", run });
		else if (data === "c" && canCancelRun(run)) this.done({ type: "cancel", run });
		else if (data === "r" && canRerunRun(run)) this.done({ type: "rerun", run });
	}

	render(width: number): string[] {
		const w = Math.max(1, width);
		const accent = (s: string) => this.theme.fg("accent", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const success = (s: string) => this.theme.fg("success", s);
		const error = (s: string) => this.theme.fg("error", s);
		const warning = (s: string) => this.theme.fg("warning", s);
		const line = (s: string) => truncateToWidth(s, w, "");
		const monitorTab = this.tab === "monitor" ? accent("[Monitor]") : muted(" Monitor ");
		const runsTab = this.tab === "runs" ? accent("[Runs]") : muted(" Runs ");
		const workflowTab = this.tab === "workflows" ? accent("[Workflows]") : muted(" Workflows ");
		const activityTab = this.tab === "activity" ? accent("[Activity]") : muted(" Activity ");
		const activeCount = this.runs.filter((run) => canCancelRun(run)).length;
		const help = this.tab === "workflows"
			? "Tab switch • ↑↓ navigate • Enter/g graph • r run with JSON + confirm • q/esc close"
			: this.tab === "monitor"
				? "Tab switch • Enter/v view • g graph • c cancel active • r rerun • q/esc close"
				: "Tab switch • m monitor • a activity • ↑↓ navigate • Enter/v view • g graph • c cancel active • r rerun • q/esc close";
		const lines: string[] = [
			line(accent("Pi Dynamic Workflows") + muted("  •  ") + monitorTab + " " + runsTab + " " + workflowTab + " " + activityTab + (activeCount ? accent(`  ▶ ${activeCount} active`) : "")),
			line(muted(help)),
			line(muted("─".repeat(Math.min(w, 120)))),
		];

		if (this.tab === "monitor") this.renderMonitor(lines, line, accent, muted, success, error, warning);
		else if (this.tab === "runs") this.renderRuns(lines, line, accent, muted, success, error);
		else if (this.tab === "workflows") this.renderWorkflows(lines, line, accent, muted, warning);
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
		label("bash", `${model.bashDone} done`);
		label("artifacts", String(model.artifactCount));
		label("run", model.runId);
		label("runDir", model.runDir);
		const last = model.lastLog ? `${model.lastLog.time.slice(11, 19)} ${model.lastLog.message}` : "No logs recorded yet.";
		label("last", last);
		const actions = ["Enter/v view", "g graph"];
		if (model.canCancel) actions.push("c cancel active");
		if (model.canRerun) actions.push("r rerun (confirm)");
		lines.push(line(muted("")));
		lines.push(line(muted(actions.join(" • "))));
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
			lines.push(line(muted("Enter/g opens graph • r runs with JSON + confirm")));
		}
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
			lines.push(line(`${prefix}${status} ${run.workflow}${bg} ${muted(run.runId)} ${getRunStatusLabel(run)} ${formatElapsedMs(getRunElapsedMs(run, state))} agents:${run.agentCount}${resumable}${cached}`));
		}
		const selected = this.runs[this.runIndex];
		if (selected) {
			lines.push(line(muted("")));
			lines.push(line(accent("Selected run")));
			lines.push(line(`status: ${getRunStatusLabel(selected)}`));
			lines.push(line(`run: ${selected.runId}`));
			lines.push(line(`dir: ${selected.runDir}`));
			for (const logEntry of getRunLogs(selected).slice(-5)) lines.push(line(`${muted(logEntry.time.slice(11, 19))} ${logEntry.message}`));
			const selectedState = getRunState(selected);
			const actions = ["Enter/v view", "g graph"];
			if (canCancelRun(selected)) actions.push("c cancel active");
			if (canRerunRun(selected)) actions.push("r rerun (confirm)");
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
				lines.push(line(`${accent("▶")} ${run.workflow} ${muted(run.runId)} ${formatElapsedMs(getRunElapsedMs(run))} agents:${run.agentCount}${lastLog ? muted(` — ${lastLog.message}`) : ""}`));
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
			const details = entry.details === undefined ? "" : muted(` — ${compactInline(entry.details, 120)}`);
			lines.push(line(`${prefix}${muted(entry.time.slice(11, 19))} ${status} ${entry.workflow} ${muted(entry.runId.slice(-12))} ${entry.message}${details}`));
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
			if (run && canCancelRun(run)) actions.push("c cancel active");
			if (run && canRerunRun(run)) actions.push("r rerun (confirm)");
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
	onProgress?: (logs: WorkflowLogEntry[]) => void,
	prepared?: PreparedWorkflowRun,
): Promise<WorkflowRunResult> {
	if (ctx.hasUI) {
		setWorkflowRunningStatus(ctx, workflow.name, []);
		setWorkflowWidget(ctx, workflow.name, []);
	}
	try {
		const result = await runWorkflow(pi, ctx, workflow, input, limits, signal, (logs) => {
			onProgress?.(logs);
			if (ctx.hasUI) {
				setWorkflowRunningStatus(ctx, workflow.name, logs);
				setWorkflowWidget(ctx, workflow.name, logs);
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

async function runWorkflowFromUi(pi: ExtensionAPI, ctx: ExtensionContext, workflow: WorkflowFile, input: unknown): Promise<WorkflowRunResult> {
	const limits = buildLimits(limitParamsFromInput(input));
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

async function openWorkflowDashboard(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		notify(ctx, "Workflow dashboard requires TUI mode. Use /workflow list, /workflow graph, /workflow runs, or /workflow view.", "warning");
		return;
	}
	const workflows = await listWorkflows(ctx);
	const runs = await listRuns(ctx);
	const [activity, monitorModels] = await Promise.all([collectWorkflowActivity(runs), deriveWorkflowMonitorModels(runs)]);
	let refreshTimer: NodeJS.Timeout | undefined;
	let refreshing = false;
	let dashboard: WorkflowDashboard | undefined;
	let choice: WorkflowDashboardResult | null = null;
	try {
		choice = await ctx.ui.custom<WorkflowDashboardResult | null>((tui, theme, _keybindings, done) => {
			dashboard = new WorkflowDashboard(workflows, runs, activity, monitorModels, theme, () => tui.requestRender(), done);
			const refresh = async () => {
				if (refreshing || !dashboard) return;
				refreshing = true;
				try {
					const nextRuns = await listRuns(ctx);
					const [nextActivity, nextMonitorModels] = await Promise.all([collectWorkflowActivity(nextRuns), deriveWorkflowMonitorModels(nextRuns)]);
					dashboard.setRuns(nextRuns);
					dashboard.setActivity(nextActivity);
					dashboard.setMonitorModels(nextMonitorModels);
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
	if (choice.type === "graph") {
		const workflow = choice.workflow ?? (choice.run ? await resolveWorkflowForRun(ctx, choice.run) : undefined);
		if (!workflow) {
			notify(ctx, "Cannot open graph: workflow file not found.", "warning");
			return;
		}
		const code = await fs.readFile(workflow.path, "utf8");
		await showText(ctx, `Workflow graph: ${workflow.name}`, makeWorkflowGraph(workflow, code));
		return;
	}
	if (choice.type === "view" && choice.run) {
		await showText(ctx, `Workflow run: ${choice.run.runId}`, await formatRunView(choice.run));
		return;
	}
	if (choice.type === "cancel" && choice.run) {
		const message = await cancelWorkflowRun(ctx, choice.run.runId);
		notify(ctx, message, "warning");
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
	onProgress?: (logs: WorkflowLogEntry[]) => void,
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
			logs,
			...(logs.length ? { lastLog: logs[logs.length - 1] } : {}),
			...(codeHash ? { codeHash } : {}),
			...(cachedCalls ? { cachedCalls } : {}),
			...(resumedFrom ? { resumedFrom } : {}),
		};
	}

	async function persistStatus(statusState: WorkflowRunState = state): Promise<void> {
		const status = makeStatus(statusState);
		await writeRunStatus(status);
	}

	async function log(message: string, details?: unknown): Promise<void> {
		const entry: WorkflowLogEntry = { time: new Date().toISOString(), message, ...(details === undefined ? {} : { details }) };
		logs.push(entry);
		await appendEvent({ type: "log", ...entry });
		await persistStatus();
		onProgress?.(logs);
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

	async function runSubagent(prompt: string, options: AgentOptions = {}): Promise<SubagentResult> {
		throwIfAborted(runSignal.signal);
		let effectiveOptions: AgentOptions = await applyPersonaOptions(ctx, options);
		if (effectiveOptions.schema !== undefined) {
			effectiveOptions = appendSystemPromptOption(effectiveOptions, makeStructuredOutputSystemPrompt(effectiveOptions.schema));
		}
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
				await log(`agent cached: ${hit.name}`, { key: key.slice(0, 12), occ });
				return hit;
			}
		}
		if (agentCount >= runLimits.maxAgents) {
			throw new Error(`Workflow exceeded maxAgents=${runLimits.maxAgents}.`);
		}
		const id = ++agentCount;
		const name = effectiveOptions.name ?? `agent-${id}`;
		const startedAt = Date.now();
		await log(`agent ${id} start: ${name}`);

		function buildAgentArgs(attemptPrompt: string): string[] {
			const args = ["-p", "--no-session", "--mode", "json"];
			if (effectiveOptions.includeExtensions !== true) args.push("--no-extensions");
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
			try {
				result = await pi.exec(piCommand, buildAgentArgs(attemptPrompt), {
					cwd: effectiveOptions.cwd ?? ctx.cwd,
					timeout: effectiveOptions.timeoutMs ?? runLimits.agentTimeoutMs,
					signal: runSignal.signal,
				});
			} finally {
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
		const elapsedMs = Date.now() - startedAt;
		const artifactName = `agents/${String(id).padStart(4, "0")}-${slugify(name)}.md`;
		const artifact = await writeArtifact(
			artifactName,
			`# ${name}\n\n- ok: ${result.code === 0 && !result.killed}\n- code: ${result.code}\n- elapsedMs: ${elapsedMs}${schema === undefined ? "" : `\n- schemaOk: ${schemaOk === true}`}\n\n## Prompt\n\n${prompt}${schema === undefined ? "" : `\n\n## Structured Output\n\n${schemaOk === true ? `Data:\n\n${safeJson(schemaData)}` : `Error:\n\n${schemaError || "schema validation failed"}`}`}\n\n## Stdout\n\n${result.stdout}\n\n## Stderr\n\n${result.stderr}\n`,
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
			...(schema === undefined ? {} : { data: schemaData, schemaOk: schemaOk === true }),
		};
		const subagent = cacheEnabled ? normalizeSubagentResultForJournal(rawSubagent) : rawSubagent;
		await appendEvent({ type: "agent", ...subagent, stdout: undefined, stderr: undefined, prompt: undefined });
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
		await log(`agent ${id} end: ${name}`, { ok: subagent.ok, code: subagent.code, elapsedMs, ...(schema === undefined ? {} : { schemaOk: subagent.schemaOk }) });
		if (schemaShouldThrow) throw new Error(`Agent ${name} did not produce valid structured output: ${schemaError || "schema validation failed"}`);
		return subagent;
	}

	// Copy of agent options excluding fields that do not affect model output, so
	// the cache key is stable across name/timeout/cache changes. prompt is also
	// dropped: it is already the first element of the cache-key array, and
	// agents() spreads a spec (which carries prompt) into options, so excluding
	// it keeps the key dependent on the prompt exactly once.
	function sanitizeAgentOpts(options: AgentOptions): Record<string, unknown> {
		const { name: _name, timeoutMs: _timeoutMs, cache: _cache, concurrency: _concurrency, settle: _settle, agentType: _agentType, ...rest } = options as AgentOptions & {
			prompt?: string;
			concurrency?: number;
			settle?: boolean;
		};
		delete (rest as { prompt?: string }).prompt;
		return rest;
	}

	async function runAgents(items: Array<string | AgentSpec>, options?: AgentOptions & { concurrency?: number; settle?: false }): Promise<SubagentResult[]>;
	async function runAgents(items: Array<string | AgentSpec>, options: AgentOptions & { concurrency?: number; settle: true }): Promise<Array<SubagentResult | null>>;
	async function runAgents(items: Array<string | AgentSpec>, options: AgentOptions & { concurrency?: number; settle?: boolean } = {}): Promise<Array<SubagentResult | null>> {
		const concurrency = Math.min(Math.max(Math.floor(options.concurrency ?? runLimits.concurrency), 1), runLimits.concurrency);
		const { concurrency: _concurrency, settle = false, ...sharedOptions } = options as AgentOptions & { concurrency?: number; settle?: boolean };
		const runItem = async (item: string | AgentSpec, index: number): Promise<SubagentResult> => {
			if (typeof item === "string") return await agent(item, { ...sharedOptions, name: sharedOptions.name ?? `agent-${index + 1}` });
			const { prompt: itemPrompt, ...itemOptions } = item;
			return await agent(itemPrompt, { ...sharedOptions, ...itemOptions, name: item.name ?? `agent-${index + 1}` });
		};
		if (settle) return await mapLimit(items, concurrency, runSignal.signal, runItem, { onError: "null" });
		return await mapLimit(items, concurrency, runSignal.signal, runItem);
	}

	const agent = (prompt: string, options: AgentOptions = {}) => trackSubagent(runSubagent(prompt, options));

	const api: WorkflowRuntimeApi = {
		cwd: ctx.cwd,
		runId,
		runDir,
		input,
		limits: runLimits,
		log,
		agent,
		agents: runAgents,
		bash: async (command, options = {}) => {
			throwIfAborted(runSignal.signal);
			// bash caching is opt-in: bash(cmd, { cache: true }). occ assigned
			// synchronously before any await for deterministic ordering.
			const cacheEnabled = options.cache === true;
			const key = computeCallKey("bash", [command, { cwd: options.cwd ?? ctx.cwd }]);
			const occ = nextOcc(key);
			if (cacheEnabled) {
				const hit = journalLookup(key, occ) as BashResult | undefined;
				if (hit && !("artifactPath" in hit)) {
					cachedCalls++;
					await log(`bash cached: ${command.slice(0, 80)}`, { key: key.slice(0, 12), occ });
					if (options.throwOnError && !hit.ok) {
						throw new Error(`Command failed (${hit.code}): ${command}\n${hit.stderr || hit.stdout}`);
					}
					return hit;
				}
			}
			const startedAt = Date.now();
			await log(`bash start: ${command.slice(0, 120)}`);
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
			await appendEvent({ type: "bash", command, ...bashResult });
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
			await log(`bash end: ${command.slice(0, 120)}`, { ok: bashResult.ok, code: bashResult.code });
			if (options.throwOnError && !bashResult.ok) {
				throw new Error(`Command failed (${bashResult.code}): ${command}\n${bashResult.stderr || bashResult.stdout}`);
			}
			return bashResult;
		},
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

function initialRunStatus(workflow: WorkflowFile, prepared: PreparedWorkflowRun, active: boolean): WorkflowRunStatus {
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
		logs: [],
	};
}

function formatBackgroundStart(status: WorkflowRunStatus): string {
	return [
		`Started background workflow: ${status.workflow}`,
		`Run: ${status.runId}`,
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

async function startWorkflowBackground(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	workflow: WorkflowFile,
	input: unknown,
	limits: RunLimits,
	preparedRun?: PreparedWorkflowRun,
): Promise<WorkflowRunStatus> {
	if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
		throw new Error("Background workflow runs require a persistent TUI/RPC session. Use action=run instead.");
	}
	// For resume, preparedRun reuses the existing runDir/runId in place.
	const prepared = preparedRun ?? (await prepareWorkflowRun(ctx, workflow.name, true));
	const controller = new AbortController();
	const active: ActiveWorkflowRun = { runId: prepared.runId, runDir: prepared.runDir, started: prepared.started, workflow, controller };
	activeRuns.set(prepared.runId, active);
	const status = initialRunStatus(workflow, prepared, true);
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
				logs: [],
				error,
			};
			await writeJsonFile(path.join(prepared.runDir, "result.json"), result);
			await writeRunStatus({ ...initialRunStatus(workflow, prepared, false), state: "failed", endedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), elapsedMs: now - prepared.started, error });
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
	onProgress?: (logs: WorkflowLogEntry[]) => void,
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

	const prepared: PreparedWorkflowRun = {
		started: Number.isFinite(new Date(record.startedAt).getTime()) ? new Date(record.startedAt).getTime() : Date.now(),
		runId: record.runId,
		runDir: record.runDir,
		background: !!opts.background,
		resume: { journal, baseAgentCount, codeHash, resumedFrom: record.runId },
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

	if (opts.background) {
		// Returns a WorkflowRunStatus (the run keeps executing in the background).
		return await startWorkflowBackground(pi, ctx, workflow, input, limits, prepared);
	}

	// Foreground: returns a WorkflowRunResult.
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
		return { content: [text(WORKFLOW_TEMPLATE)], details: { action, template: WORKFLOW_TEMPLATE } };
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
		const record = await resumeWorkflow(
			pi,
			ctx,
			params.name,
			{ background: !!params.background, force: !!params.force },
			signal,
			(logs) => {
				const preview = logs.slice(-8).map((entry) => `${entry.time.slice(11, 19)} ${entry.message}`).join("\n");
				onUpdate?.({ content: [text(preview)], details: { action, logCount: logs.length } });
			},
		);
		if (params.background) {
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
		const graph = makeWorkflowGraph(workflow, code);
		return { content: [text(graph)], details: { action, workflow, graph } };
	}

	if (action === "write") {
		if (params.code === undefined) throw new Error("dynamic_workflow action=write requires code.");
		const workflow = await resolveWorkflow(ctx, params.name, scope, true);
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

	if (action === "start" || (action === "run" && params.background)) {
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

		if (action === "graph" || action === "viz") {
			const name = commandName;
			if (!name) {
				notify(ctx, "Usage: /workflow graph <name>", "warning");
				return;
			}
			const workflow = await resolveWorkflow(ctx, name, "auto");
			const code = await fs.readFile(workflow.path, "utf8");
			await showText(ctx, `Workflow graph: ${workflow.name}`, makeWorkflowGraph(workflow, code));
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
				notify(ctx, "Usage: /workflow new <name>", "warning");
				return;
			}
			if (!ctx.hasUI) {
				notify(ctx, "/workflow new requires interactive UI. Use dynamic_workflow action=write in agent mode.", "warning");
				return;
			}
			const edited = await ctx.ui.editor(`New workflow: ${name}`, WORKFLOW_TEMPLATE);
			if (edited === undefined) return;
			const workflow = await resolveWorkflow(ctx, name, "project", true);
			await ensureDir(path.dirname(workflow.path));
			await fs.writeFile(workflow.path, edited, "utf8");
			notify(ctx, `Wrote ${workflow.path}`, "info");
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
			// --background/--bg and --force flags in any order. Foreground by default.
			const tokens = afterAction.split(/\s+/).filter(Boolean);
			const background = tokens.some((t) => t === "--background" || t === "--bg" || t === "-b");
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

		notify(ctx, "Usage: /workflow list | dashboard | graph <name> | runs | view [latest|runId] | new <name> | edit <name> | run <name> [json] | start <name> [json] | resume [latest|runId] [--background] [--force] | cancel [latest|runId] | delete <name>", "warning");
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
			? "Use Pi Dynamic Workflows for a deep-research style investigation."
			: "Use Pi Dynamic Workflows (Claude-style ultracode) for this complex task.";
	return `${header}

Task:
${trimmed}

Instructions:
- Decide whether a workflow is warranted. If the task is simple, say so and proceed normally.
- If warranted, use the dynamic_workflow tool to inspect the template, create or reuse a project workflow, and run it with explicit concurrency/maxAgents limits.
- For long-running research/audit tasks in persistent sessions, prefer action=start and poll with action=runs/view instead of blocking the chat.
- Use parallel subagents for independent exploration, verification, review, or research branches.
- Keep expensive fan-out bounded; prefer read-only tools for audit/research subagents.
- Persist intermediate state with ctx.writeArtifact() and synthesize a concise final answer with citations or file paths where relevant.`;
}

function makeAlwaysOnUltracodeSystemPrompt(): string {
	return `## Always-on Ultracode Workflow Router

For every substantive task, silently run this decision before choosing an approach. Do not narrate it for trivial tasks.

1. Trivial gate. Conversational, single-step, or a few direct tool calls -> solve normally, single-agent. Do not build a workflow.
2. Scout inline first. If the task might be large, probe it cheaply this turn (git ls-files, read the diff, grep/glob candidates) to learn the real work-list and its size. You need the work-list before the orchestration step, not before the task.
3. Orchestrate only for a reason. After scouting, prefer dynamic_workflow only when one holds: exhaustiveness (many independent items in parallel), confidence (independent perspectives + adversarial verification before committing), or scale (more context than one window holds: migrations, audits, broad sweeps, long-running work with checkpoints). Else stay single-agent.
4. Scale to the ask. Light ("find some", "quick check") -> small fan-out (~3-5) + light synthesis. Heavy ("audit thoroughly", "be exhaustive") -> larger pool + adversarial reviewers/judges + synthesis, repeating only when the work-list is still yielding new findings.

When a workflow is warranted: scout inline, then use ctx.agents(items,{concurrency}) for one independent step per item; use ctx.pipeline(items,...stages) by default when each item needs multiple dependent steps and no cross-item merge; use ctx.agents(items,{concurrency,settle:true}) when a large fan-out should keep going and return null for failed branches; use ctx.parallel([async()=>...]) only for true barriers where a later step needs all branch results at once (global dedup/merge, early-exit when total is zero, cross-branch ranking). Include a stable item id/index in prompts that pipeline stages generate. Filter nulls, log how many branches failed, keep fan-out bounded by ctx.limits.concurrency, use read-only tools or agentType:"reviewer"/"researcher" for audit/research subagents, and ctx.log() any coverage cap instead of capping silently.

Use ctx.agent(prompt,{schema}) when a branch must return machine-readable JSON; read result.data/result.schemaOk and set schemaOnInvalid:"null" when you want settling semantics. Use agentType:"explore"|"reviewer"|"planner"|"implementer"|"researcher" as persona defaults, with explicit caller options overriding them.

Mention the routing decision only when it affects the plan, cost, latency, or user expectations.`;
}

function dynamicWorkflowToolAvailable(selectedTools: string[] | undefined): boolean {
	return selectedTools?.includes("dynamic_workflow") ?? false;
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

function sendWorkflowPrompt(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string): void {
	if (ctx.isIdle()) pi.sendUserMessage(prompt);
	else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

export default function dynamicWorkflowsExtension(pi: ExtensionAPI): void {
	let ultracodeAlwaysOn = true;

	pi.registerTool({
		name: "dynamic_workflow",
		label: "Dynamic Workflow",
		description:
			"Create, manage, and run Claude-style dynamic workflows: JavaScript orchestration scripts that can spawn parallel Pi subagents and store artifacts outside chat context.",
		promptSnippet: "Create/list/read/write/run/start JavaScript workflows that orchestrate parallel Pi subagents.",
		promptGuidelines: [
			"Decide in three steps before orchestrating. (1) Trivial gate: if the task is conversational, single-step, or solvable with a few direct tool calls, answer normally — do NOT build a workflow. (2) Scout inline first: if it may be large, run a cheap probe inline (git ls-files, read the diff, grep/glob candidates) to discover the real work-list and size. (3) Orchestrate only for exhaustiveness (many independent items), confidence (independent perspectives + adversarial verification), or scale (more context than one window: migrations, audits, broad sweeps).",
			"Scale effort to the ask. 'Find some' / 'quick check' -> small fan-out (~3-5) + light synthesis. 'Review this plan' -> a few perspective-diverse reviewers + synthesis-as-judge. 'Audit thoroughly' / 'be exhaustive' -> larger pool, adversarial checks per finding, synthesis, and another round only if new findings keep appearing.",
			"Choose primitives by data dependency. Use ctx.agents(items,{concurrency}) for one independent step per item. Use ctx.pipeline(items,...stages) by default for >=2 dependent steps per item with no cross-item merge; include a stable item id/index in prompts generated inside stages. Use ctx.agents(items,{concurrency,settle:true}) for large fan-out or reviewer panels where one branch failure should return null. Use ctx.parallel([async()=>...]) only for a true barrier where a later step needs all branch results at once (dedup/merge, early-exit if total=0, cross-branch ranking).",
			"Use ctx.agent(prompt,{schema}) when a subagent must return JSON; consume result.data/result.schemaOk and use schemaOnInvalid:'null' when invalid JSON should become a non-throwing branch result. Use agentType:'explore'|'reviewer'|'planner'|'implementer'|'researcher' for persona defaults; explicit options override the persona.",
			"Handle partial failure visibly: filter nulls from settling agents/pipeline/parallel, ctx.log() how many branches failed, and make synthesis prompts mention failed, empty, cancelled, or timed-out branches instead of hiding them.",
			"Never cap coverage silently. Whenever a workflow uses slice/head/top-N/sampling/no-retry or clamps concurrency to ctx.limits.concurrency, ctx.log() exactly what was excluded or clamped.",
			"When creating a workflow, first request dynamic_workflow action=template or read an existing workflow, then write a clear JavaScript file under project scope and run it with explicit limits.",
			"For long-running workflows in persistent TUI/RPC sessions, prefer dynamic_workflow action=start (or action=run with background=true), then inspect with action=runs/view and stop with action=cancel if needed.",
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
		description: "Manage dynamic workflows: /workflow list|graph|runs|view|new|edit|run|start|resume|cancel|delete",
		handler: async (args, ctx) => await handleWorkflowCommand(pi, args, ctx),
	});

	pi.registerCommand("workflows", {
		description: "Open the dynamic workflows monitor dashboard or pass through to /workflow",
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
		return { action: "transform" as const, text: makeUltracodePrompt(task, "ultracode"), images: event.images };
	});

	pi.on("before_agent_start", async (event) => {
		if (!ultracodeAlwaysOn) return;
		if (!dynamicWorkflowToolAvailable(event.systemPromptOptions.selectedTools)) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${makeAlwaysOnUltracodeSystemPrompt()}`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		refreshActiveWorkflowStatus(ctx);
		setUltracodeStatus(ctx, ultracodeAlwaysOn);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await abortActiveWorkflowRuns("Workflow cancelled by session shutdown.");
		clearWorkflowWidget(ctx);
		setWorkflowIdleStatus(ctx);
		clearUltracodeStatus(ctx);
	});
}
