import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	applyDefaultAgentAccess,
	applyPersonaOptions,
	createAgentEnvWrapper,
	formatAgentAccessMarkdown,
	normalizeAgentEnvAccess,
} from "./agent-env-persona.js";
import { parsePiJsonModeOutput, parsePiJsonModeOutputLenient } from "./agent-output.js";
import {
	AsyncMutex,
	abortReasonMessage,
	combineSignal,
	createSemaphore,
	mapLimit,
	sleep,
	throwIfAborted,
} from "./concurrency-primitives.js";
import { phaseEventFields } from "./event-parser.js";
import { appendJsonLine } from "./file-append.js";
import {
	type AgentFocusMetrics,
	aggregateRunFocusMetrics,
	formatFocusMetricsMarkdown,
	parseAgentFocusMetrics,
} from "./focus-metrics.js";
import { MAX_TOOL_TEXT, safeJson, stringify, truncate } from "./format.js";
import {
	appendJournalRecord,
	computeCallKey,
	computeCodeHash,
	lookupJournalRecord,
	makeJournalRecord,
	normalizeBashResultForJournal,
	normalizeSubagentResultForJournal,
} from "./journal.js";
import { extractJsonCandidate } from "./json-extract.js";
import { OccurrenceCounter } from "./occurrence-counter.js";
import { resolveArtifactPath, resolveCwdPath } from "./path-safety.js";
import { runStreamingAgentProcess, type StreamingProcessResult } from "./process-spawn.js";
import { hasActiveRun } from "./run-registry.js";
import { formatRunSummary } from "./run-status-ui.js";
import { writeJsonFile, writeRunStatus } from "./run-store.js";
import { MAX_AGENT_OUTPUT_IN_RESULT, MAX_JOURNALED_STREAM } from "./runtime-constants.js";
import {
	appendSystemPromptOption,
	formatSchemaRetryPrompt,
	makeStructuredOutputSystemPrompt,
	validateStructuredData,
} from "./structured-output.js";
import type {
	AgentOptions,
	AgentPhaseInfo,
	AskResult,
	BashResult,
	PreparedWorkflowRun,
	RunLimits,
	SubagentResult,
	WorkflowDefinition,
	WorkflowLogEntry,
	WorkflowResultIntegrity,
	WorkflowRunResult,
	WorkflowRunState,
	WorkflowRunStatus,
} from "./types.js";
import { buildAgentProcess, hostBinName, sanitizeAgentOpts } from "./workflow-agent-process.js";
import { currentWorkflowDepth, WORKFLOW_DEPTH_ENV } from "./workflow-depth.js";
import { preflightWorkflowLaunch } from "./workflow-preflight.js";
import { ensureDir, resolveWorkflow, slugify } from "./workflow-resolve.js";
import { prepareWorkflowRun } from "./workflow-run-prepare.js";
import { writeWorkflowRunSnapshots } from "./workflow-run-snapshots.js";
import { makeModelArg, TIER_ALIASES, tierModelTable } from "./workflow-tier-models.js";
import { callSignal, executeWorkflowCode } from "./workflow-worker-bridge.js";

const MAX_AGENT_PROMPT_COPY_IN_EVENT = 16_000;

interface InternalAgentOptions extends AgentOptions {
	/**
	 * Azúcar a nivel de worker. El global agent() del worker mapea effort->thinking y label->name
	 * antes de publicar, pero las especificaciones per-item de agents(), las opciones compartidas de agents() y las llamadas ctx-style
	 * llegan al host sin mapear — así que runSubagent normaliza ambas en la entrada (effort -> thinking con
	 * max -> xhigh, label -> name) y las elimina (issues #22/#23).
	 */
	effort?: string;
	label?: string;
	__workflowPhase?: AgentPhaseInfo;
	__workflowNamespace?: string;
}

interface AgentSpec extends InternalAgentOptions {
	prompt: string;
}

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
	/** La respuesta es secreta: nunca la persistas (events/journal) ni la reproduzcas al reanudar. */
	secret?: boolean;
	__workflowNamespace?: string;
}

interface WorkflowRuntimeApi {
	cwd: string;
	runId: string;
	runDir: string;
	input: unknown;
	limits: Readonly<RunLimits>;
	log(message: string, details?: unknown): Promise<void>;
	phase(label: string): Promise<void>;
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

let tierEnvWarned = false;

export async function runWorkflow(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	workflowDefinition: WorkflowDefinition,
	input: unknown,
	limits: RunLimits,
	signal: AbortSignal | undefined,
	onProgress?: (logs: WorkflowLogEntry[], status?: WorkflowRunStatus) => void,
	prepared?: PreparedWorkflowRun,
): Promise<WorkflowRunResult> {
	if (!prepared) await preflightWorkflowLaunch(ctx, workflowDefinition, input);
	const preparedRun = prepared ?? (await prepareWorkflowRun(ctx, workflowDefinition.name, false));
	const { started, runId, runDir } = preparedRun;
	const runLimits: Readonly<RunLimits> = Object.freeze({ ...limits });
	const agentsDir = path.join(runDir, "agents");
	await ensureDir(agentsDir);

	const runSignal = combineSignal(signal, runLimits.timeoutMs);
	const agentSemaphore = createSemaphore(runLimits.concurrency, runSignal.signal);
	const trackedSubagents = new Set<Promise<unknown>>();
	const logs: WorkflowLogEntry[] = [];
	// Ejecuciones reanudadas comienzan agentCount más allá de los artefactos agents/NNNN ya en disco
	// para que los subagentes recién re-ejecutados nunca sobrescriban los en caché. Ese ID histórico
	// no es un presupuesto: maxAgents limita solo los lanzamientos frescos de esta ejecución.
	let agentCount = preparedRun.resume?.baseAgentCount ?? 0;
	let launchedAgents = 0;
	let agentPhaseCount = 0;
	let explicitPhaseCount = 0;
	let parallelAgents = 0;
	let peakParallelAgents = preparedRun.resume?.previousPeakParallelAgents ?? 0;
	let state: WorkflowRunState = "running";

	// Content-address cache (for resumable/idempotent runs).
	let codeHash = preparedRun.resume?.codeHash ?? "";
	const resumedFrom = preparedRun.resume?.resumedFrom;
	const journal = preparedRun.resume?.journal;
	const occurrences = new OccurrenceCounter();
	// Serializes the occ-assignment prologue (persona/access resolution + key + occ assignment).
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
	const integrity: WorkflowResultIntegrity = {
		agentResults: 0,
		failedAgents: 0,
		emptyOutputAgents: 0,
		outputTruncatedAgents: 0,
		stdoutTruncatedAgents: 0,
		timedOutAgents: 0,
		schemaFailedAgents: 0,
	};

	function recordAgentIntegrity(result: SubagentResult): void {
		integrity.agentResults++;
		if (!result.ok) integrity.failedAgents++;
		if (result.outputEmpty) integrity.emptyOutputAgents++;
		if (result.outputTruncated) integrity.outputTruncatedAgents++;
		if (result.stdoutTruncated) integrity.stdoutTruncatedAgents++;
		if (result.timedOut) integrity.timedOutAgents++;
		if (result.schemaOk === false) integrity.schemaFailedAgents++;
	}

	function resultIntegrity(): WorkflowResultIntegrity | undefined {
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
		const tracked = promise.finally(() => trackedSubagents.delete(tracked));
		trackedSubagents.add(tracked);
		return tracked;
	}

	async function appendEvent(event: unknown): Promise<void> {
		await appendJsonLine(path.join(runDir, "events.jsonl"), event);
	}

	function makeStatus(statusState: WorkflowRunState = state, now = Date.now()): WorkflowRunStatus {
		const integrity = resultIntegrity();
		return {
			workflow: workflowDefinition.name,
			scope: workflowDefinition.scope,
			file: workflowDefinition.path,
			runId,
			runDir,
			state: statusState,
			background: preparedRun.background,
			active: statusState === "running" && hasActiveRun(runId),
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
			...(integrity ? { integrity } : {}),
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

	async function phase(label: string): Promise<void> {
		const text = String(label ?? "").trim();
		if (!text) return;
		const time = new Date().toISOString();
		const id = ++explicitPhaseCount;
		await appendEvent({ type: "phase", id, label: text, time });
		await log(`phase: ${text}`);
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
		// Normalize worker-level sugar HOST-SIDE so EVERY path honors it — the worker's agent()
		// global already maps effort->thinking, but agents() per-item specs, agents() shared
		// options, and ctx-style calls arrive unmapped (issue #22: effort was silently dropped
		// while still polluting the cache key). Done BEFORE the persona merge so an explicit
		// per-item effort overrides a persona's thinking default, and BEFORE computeCallKey so
		// the key sees the normalized `thinking` (journals recorded with raw `effort` items no
		// longer match on resume and re-run — accepted, see #22).
		const normalized: InternalAgentOptions = { ...options };
		if (normalized.effort != null) {
			if (normalized.thinking == null)
				normalized.thinking = normalized.effort === "max" ? "xhigh" : String(normalized.effort);
			delete normalized.effort;
		}
		// Same for label -> name (#23): runAgents prefers item.label when naming a spec item, so
		// this mapping covers direct/ctx-style calls; the delete keeps label out of the cache key.
		if (normalized.label != null) {
			if (normalized.name == null) normalized.name = String(normalized.label);
			delete normalized.label;
		}
		const prologue = await occAssignMutex.runExclusive(async () => {
			let resolved = (await applyPersonaOptions(ctx, normalized)) as InternalAgentOptions;
			resolved = await applyDefaultAgentAccess(ctx, resolved);
			if (resolved.schema !== undefined) {
				resolved = appendSystemPromptOption(resolved, makeStructuredOutputSystemPrompt(resolved.schema));
			}
			const computedKey = computeCallKey("agent", [prompt, sanitizeAgentOpts(resolved)]);
			return { effectiveOptions: resolved, key: computedKey, occ: occurrences.next(computedKey) };
		});
		const effectiveOptions = prologue.effectiveOptions;
		const { key, occ } = prologue;
		const phase = effectiveOptions.__workflowPhase;
		const envAccess = normalizeAgentEnvAccess(effectiveOptions);
		const accessMarkdown = formatAgentAccessMarkdown(effectiveOptions, envAccess);
		const cacheEnabled = effectiveOptions.cache !== false;
		if (cacheEnabled) {
			const hit = lookupJournalRecord(journal, key, occ) as SubagentResult | undefined;
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
					outputChars: hit.outputChars ?? hit.output.length,
					...((hit.outputEmpty ?? hit.output.trim().length === 0) ? { outputEmpty: true } : {}),
					...(hit.outputTruncated ? { outputTruncated: true } : {}),
				};
				recordAgentIntegrity(cachedHit);
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
		if (launchedAgents >= runLimits.maxAgents) {
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
				launchedAgents,
				...phaseEventFields(phase),
			});
			throw new Error(capMessage);
		}
		launchedAgents++;
		const id = ++agentCount;
		const name = effectiveOptions.name ?? `agent-${id}`;
		const startedAt = Date.now();
		const startedAtIso = new Date(startedAt).toISOString();
		const artifactName = `agents/${String(id).padStart(4, "0")}-${slugify(name)}.md`;
		const phaseFields = phaseEventFields(phase);
		const phaseLine = phase?.total
			? `\n- phase: P${phase.id} ${phase.index}/${phase.total}${phase.label ? ` (${phase.label})` : ""}`
			: "";
		// Resolve model/provider/thinking ONCE, up front, so the start/end events, the .md
		// artifact, and the SubagentResult all record what this subagent ACTUALLY runs with
		// (the monitor renders these), and buildAgentArgs consumes the same resolved values.
		// A BARE pattern alias ("sonnet"/"opus"/"haiku" — no "provider/") resolves through pi's provider
		// routing and can land on an UNauthenticated provider (e.g. amazon-bedrock -> "No API key found"),
		// which silently kills the subagent. Pin a bare alias to the session's provider so the shared
		// dual-platform scaffolds (which use bare aliases for Claude Code) resolve within the authenticated
		// provider on pi. An explicit provider always wins; qualified ids ("provider/id") and omitted models
		// (already qualified by makeModelArg) are left untouched.
		let resolvedModel = effectiveOptions.model ?? (effectiveOptions.provider ? undefined : makeModelArg(ctx));
		const resolvedProvider =
			effectiveOptions.provider ?? (resolvedModel && !resolvedModel.includes("/") ? ctx.model?.provider : undefined);
		// #24: a bare LADDER alias pinned to a provider whose catalog lacks it would fail fast.
		// Map it to that provider's tier id from the table, but ONLY when the model registry
		// confirms the target exists — otherwise keep the verbatim pin (visible fail-fast); the
		// session model is NEVER silently substituted. This runs AFTER the prologue computed the
		// cache key from the RAW alias, so mapping never changes keys or invalidates journals.
		let tierAliasNote: { message: string; details: Record<string, unknown> } | undefined;
		if (resolvedModel && resolvedProvider && !resolvedModel.includes("/") && TIER_ALIASES.has(resolvedModel)) {
			const { table, error } = tierModelTable();
			if (error && !tierEnvWarned) {
				tierEnvWarned = true;
				await log(`invalid PI_DYNAMIC_WORKFLOWS_TIER_MODELS (using builtin tier table): ${error}`);
			}
			const mappedId = table[resolvedProvider]?.[resolvedModel];
			if (mappedId && mappedId !== resolvedModel) {
				if (ctx.modelRegistry?.find?.(resolvedProvider, mappedId)) {
					tierAliasNote = {
						message: `tier alias mapped: ${resolvedModel} -> ${resolvedProvider}/${mappedId}`,
						details: { alias: resolvedModel, provider: resolvedProvider, model: mappedId },
					};
					resolvedModel = mappedId;
				} else {
					tierAliasNote = {
						message: `tier alias not confirmed by the model registry: ${resolvedProvider}/${mappedId} — pinning "${resolvedModel}" verbatim (may fail fast)`,
						details: { alias: resolvedModel, provider: resolvedProvider, unconfirmed: mappedId },
					};
				}
			}
		}
		if (tierAliasNote) await log(tierAliasNote.message, tierAliasNote.details);
		const rawThinking = effectiveOptions.thinking ?? pi.getThinkingLevel?.();
		const resolvedThinking = rawThinking ? String(rawThinking) : undefined;
		// Recorded (display) form: qualify a bare model with the pinned provider so the
		// monitor shows the same fully-resolved id the subagent runs with.
		const recordedModel =
			resolvedModel && resolvedProvider && !resolvedModel.includes("/")
				? `${resolvedProvider}/${resolvedModel}`
				: resolvedModel;
		const modelLine = recordedModel ? `\n- model: ${recordedModel}` : "";
		const thinkingLine = resolvedThinking ? `\n- thinking: ${resolvedThinking}` : "";
		const preliminaryArtifact = await writeArtifact(
			artifactName,
			`# ${name}\n\n- state: running\n- startedAt: ${startedAtIso}${modelLine}${thinkingLine}${phaseLine}\n\n## Access\n\n${accessMarkdown}\n\n## Prompt\n\n${prompt}\n`,
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
			...(recordedModel ? { model: recordedModel } : {}),
			...(resolvedThinking ? { thinking: resolvedThinking } : {}),
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
			model: recordedModel,
			thinking: resolvedThinking,
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

		// Default to the HOST distribution's own binary (bin name === piConfig.name:
		// "pi" under vanilla pi, "pi-cante" under pi-cante) so subagents inherit the
		// same distribution and config dir. The env override still wins.
		const piCommand = process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND || hostBinName();
		let envWrapper: { path: string; dir: string } | undefined;
		function agentProcessFor(attemptPrompt: string): { command: string; args: string[] } {
			return buildAgentProcess({
				attemptPrompt,
				effectiveOptions,
				resolvedProvider,
				resolvedModel,
				resolvedThinking,
				defaultApprove: ctx.isProjectTrusted(),
				piCommand,
				envWrapper,
			});
		}
		const schema = effectiveOptions.schema;
		const schemaRetries = schema === undefined ? 0 : Math.max(0, Math.floor(effectiveOptions.schemaRetries ?? 2));
		const schemaOnInvalid = effectiveOptions.schemaOnInvalid ?? "throw";
		let result: StreamingProcessResult | undefined;
		const agentTimeoutMs = effectiveOptions.timeoutMs ?? runLimits.agentTimeoutMs;
		// Semaphore wait before the FIRST spawn. elapsedMs spans queue + all attempts, so
		// without this the tell-tale "every agent dies at exactly agentTimeoutMs" pattern
		// is invisible under high queueing (seen: 10-min kills reported as 23-31 min).
		let queuedMs: number | undefined;
		// The COMPLETE stdout of the latest attempt, read back from the on-disk live
		// artifact. The in-memory result.stdout is a bounded tail (MAX_JOURNALED_STREAM)
		// whose line-boundary trim can even come back EMPTY when the final JSON event
		// line alone exceeds the cap (giant agent_end replays on long conversations),
		// so every decision (output extraction, schema validation, focus metrics) must
		// run on the disk copy; the memory tail is only the fallback when the live
		// write failed.
		let attemptStdout = "";
		let fullOutput = "";
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
			if (queuedMs === undefined) queuedMs = Date.now() - startedAt;
			parallelAgents++;
			peakParallelAgents = Math.max(peakParallelAgents, parallelAgents);
			let countedParallelSlot = true;
			let attemptWrapper: { path: string; dir: string } | undefined;
			// Schema-retry attempts APPEND to the same live artifact, so remember where
			// this attempt starts to read back exactly its bytes afterwards.
			let attemptStdoutStart = 0;
			try {
				// (B1) A loser aborted DURING setup (resume cache-hit winner, or concurrency<branches)
				// throws here BEFORE spawning -> no token spend. First statement inside the try so the
				// finally still releases the semaphore (acquire is outside the try).
				throwIfAborted(effectiveSignal);
				await publishStatus();
				attemptWrapper = envAccess.useEnvCommand ? await createAgentEnvWrapper(envAccess) : undefined;
				envWrapper = attemptWrapper;
				attemptStdoutStart = await fs
					.stat(liveStdoutArtifact.path)
					.then((s) => s.size)
					.catch(() => 0);
				const processSpec = agentProcessFor(attemptPrompt);
				result = await runStreamingAgentProcess(processSpec.command, processSpec.args, {
					cwd: effectiveOptions.cwd ?? ctx.cwd,
					timeoutMs: agentTimeoutMs,
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
			attemptStdout = result.stdout;
			if (liveWriteError === undefined) {
				try {
					attemptStdout = (await fs.readFile(liveStdoutArtifact.path))
						.subarray(attemptStdoutStart)
						.toString("utf8");
				} catch {
					attemptStdout = result.stdout;
				}
			}
			const parsedStrictOutput = parsePiJsonModeOutput(attemptStdout);
			const parsedOutput = parsedStrictOutput.ok ? parsedStrictOutput : parsePiJsonModeOutputLenient(attemptStdout);
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
			fullOutput = parsedOutput.ok ? parsedOutput.output : attemptStdout.trim() || result.stderr.trim();
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
		const focus = parseAgentFocusMetrics(attemptStdout, {
			id,
			name,
			ok: result.code === 0 && !result.killed,
			elapsedMs,
		});
		focusByAgent.push(focus);
		// Bounded head of the authoritative disk stdout for the .md embed and the
		// journaled result; the complete copy stays in the adjacent .stdout.log.
		const boundedStdout = truncate(attemptStdout, MAX_JOURNALED_STREAM);
		const outputEmpty = fullOutput.trim().length === 0;
		const outputTruncated = fullOutput.length > MAX_AGENT_OUTPUT_IN_RESULT;
		const stdoutTruncated = result.stdoutTruncated || attemptStdout.length > MAX_JOURNALED_STREAM;
		const outputChars = fullOutput.length;
		const stdoutChars = Math.max(result.stdoutChars ?? 0, attemptStdout.length);
		const timeoutLine = result.timedOut ? `\n- timedOut: true (timeoutMs ${agentTimeoutMs})` : "";
		const queuedLine = `\n- queuedMs: ${queuedMs ?? 0}`;
		const integrityLine = `\n- outputEmpty: ${outputEmpty}\n- outputTruncated: ${outputTruncated}\n- stdoutTruncated: ${stdoutTruncated}\n- outputChars: ${outputChars}\n- stdoutChars: ${stdoutChars}`;
		const focusLine = `\n- focus: ${focus.turns} turns, peakInput ${focus.inputTokensPeak} tok, out ${focus.outputTokensTotal} tok, tools ${focus.toolCalls} (${focus.toolErrors} err), retries ${focus.autoRetries}`;
		const artifact = await writeArtifact(
			artifactName,
			`# ${name}\n\n- ok: ${result.code === 0 && !result.killed}\n- code: ${result.code}\n- elapsedMs: ${elapsedMs}${queuedLine}${timeoutLine}${integrityLine}${focusLine}${modelLine}${thinkingLine}${phaseLine}${schema === undefined ? "" : `\n- schemaOk: ${schemaOk === true}`}\n\n## Access\n\n${accessMarkdown}\n\n## Prompt\n\n${prompt}${schema === undefined ? "" : `\n\n## Structured Output\n\n${schemaOk === true ? `Data:\n\n${safeJson(schemaData)}` : `Error:\n\n${schemaError || "schema validation failed"}`}`}\n\n## Stdout\n\n${boundedStdout}\n\n## Stderr\n\n${result.stderr}\n`,
		);
		const rawSubagent: SubagentResult = {
			id,
			name,
			ok: result.code === 0 && !result.killed,
			code: result.code,
			killed: result.killed,
			...(result.timedOut ? { timedOut: true } : {}),
			elapsedMs,
			queuedMs: queuedMs ?? 0,
			prompt,
			output,
			outputChars,
			...(outputEmpty ? { outputEmpty: true } : {}),
			...(outputTruncated ? { outputTruncated: true } : {}),
			...(stdoutTruncated ? { stdoutTruncated: true } : {}),
			stdoutChars,
			stdout: boundedStdout,
			stderr: result.stderr,
			artifactPath: artifact.path,
			...(recordedModel ? { model: recordedModel } : {}),
			...(resolvedThinking ? { thinking: resolvedThinking } : {}),
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
		const promptCopy =
			prompt.length > MAX_AGENT_PROMPT_COPY_IN_EVENT ? prompt.slice(0, MAX_AGENT_PROMPT_COPY_IN_EVENT) : prompt;
		const promptTruncated = prompt.length > MAX_AGENT_PROMPT_COPY_IN_EVENT;
		const subagent = cacheEnabled ? normalizeSubagentResultForJournal(rawSubagent) : rawSubagent;
		// A loser whose abort ARRIVED produces a hole, never a record or a phantom "completed" event.
		// (A loser that completed before the abort round-tripped still journals -> B2, accepted.)
		if (effectiveSignal.aborted && !runSignal.signal.aborted)
			await log("agent cancelled (race lost)", { key: key.slice(0, 12), occ });
		throwIfAborted(effectiveSignal);
		recordAgentIntegrity(subagent);
		await appendEvent({
			type: "agent",
			...subagent,
			state: subagent.ok ? "completed" : "failed",
			startedAt: startedAtIso,
			endedAt: endedAtIso,
			promptAvailable: true,
			promptCopy,
			promptTruncated,
			metrics: focus,
			stdout: undefined,
			stderr: undefined,
			prompt: undefined,
		});
		if (!schemaShouldThrow && cacheEnabled) {
			await appendJournalRecord(
				runDir,
				makeJournalRecord({ key, occ, method: "agent", codeHash, result: subagent }),
			);
		}
		await log(`agent ${id} end: ${name}`, {
			ok: subagent.ok,
			code: subagent.code,
			...(result.timedOut ? { timedOut: true, timeoutMs: agentTimeoutMs } : {}),
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
			const runItem = async (
				item: string | AgentSpec,
				index: number,
				fanSignal?: AbortSignal,
			): Promise<SubagentResult> => {
				const __workflowPhase: AgentPhaseInfo = {
					id: phaseId,
					index: index + 1,
					total: items.length,
					label: phaseLabel,
				};
				const invoke = () => {
					if (typeof item === "string")
						return agentRunner(item, {
							...sharedOptions,
							__workflowPhase,
							name: sharedOptions.name ?? `agent-${index + 1}`,
						});
					const { prompt: itemPrompt, ...itemOptions } = item;
					return agentRunner(itemPrompt, {
						...sharedOptions,
						...itemOptions,
						__workflowPhase,
						// Per-item label is the documented way to name a spec node (#23); the
						// prologue later strips the stale label field from the cache key.
						name: item.name ?? item.label ?? `agent-${index + 1}`,
					});
				};
				// Run under mapLimit's fan-out-scoped signal (parented on fanoutSignal) so a
				// fail-fast abort cancels this in-flight subagent — runSubagent captures
				// callSignal.getStore() at entry.
				return fanSignal ? await callSignal.run(fanSignal, invoke) : await invoke();
			};
			// Fan out under the per-call signal when present (agents() dispatched inside callSignal),
			// so an abort-call for this agents() call (a race loser) cancels the whole fan-out; falls
			// back to the run signal for a bare agents() call.
			const fanoutSignal = callSignal.getStore() ?? runSignal.signal;
			if (settle) return await mapLimit(items, concurrency, fanoutSignal, runItem, { onError: "null" });
			return await mapLimit(items, concurrency, fanoutSignal, runItem);
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
		const occ = occurrences.next(key);
		if (cacheEnabled) {
			const hit = lookupJournalRecord(journal, key, occ);
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
			await appendJournalRecord(
				runDir,
				makeJournalRecord({ key, occ, method: "bash", codeHash, result: bashResult }),
			);
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
		const secret = options.secret === true;
		// A secret answer must never touch disk: force-disable the journal so it is neither written
		// to journal.jsonl nor replayed on resume, and redact it in the live event + log below. The
		// real value is still returned to the workflow.
		const cacheEnabled = !secret && options.cache !== false;
		const redactedAnswer = secret ? "[redacted]" : undefined;
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
		const occ = occurrences.next(key);
		if (cacheEnabled) {
			const hit = lookupJournalRecord(journal, key, occ) as AskResult | undefined;
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
			answer: redactedAnswer ?? answer,
			...(dismissed ? { dismissed: true } : {}),
			...(defaulted ? { defaulted: true } : {}),
			...(namespace ? { workflowNamespace: namespace } : {}),
		});
		if (cacheEnabled) {
			await appendJournalRecord(runDir, makeJournalRecord({ key, occ, method: "ask", codeHash, result }));
		}
		await log(`ask answered: ${question.slice(0, 80)}`, { answer: redactedAnswer ?? answer, defaulted });
		return answer;
	}

	async function runSubworkflow(name: string, workflowInput: unknown = {}): Promise<unknown> {
		throwIfAborted(runSignal.signal);
		const subWorkflow = await resolveWorkflow(ctx, name, "auto");
		if (path.resolve(subWorkflow.path) === path.resolve(workflowDefinition.path)) {
			throw new Error(
				`workflow() refused recursive call to ${subWorkflow.name}. Sub-workflows are depth-1 and may not call their parent.`,
			);
		}
		const subCode = await fs.readFile(subWorkflow.path, "utf8");
		const subCodeHash = computeCodeHash(subCode);
		const workflowCallKey = computeCallKey("workflow", [subWorkflow.name, workflowInput]);
		const workflowOcc = occurrences.next(workflowCallKey);
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
			phase,
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
		const code = await fs.readFile(workflowDefinition.path, "utf8");
		if (!codeHash) codeHash = computeCodeHash(code);
		await writeWorkflowRunSnapshots(ctx, workflowDefinition, code, runDir);
		await persistStatus();
		await log(`workflow start: ${workflowDefinition.name}`, {
			file: workflowDefinition.path,
			runDir,
			...(resumedFrom ? { resumedFrom } : {}),
		});
		output = await executeWorkflowCode(workflowDefinition, code, api, input, runLimits, runSignal.signal);
		state = "completed";
		await log(`workflow end: ${workflowDefinition.name}`);
	} catch (err) {
		error = err instanceof Error ? err.stack || err.message : String(err);
		const reason = runSignal.signal.aborted ? abortReasonMessage(runSignal.signal) : "";
		state = reason.toLowerCase().includes("cancel") ? "cancelled" : "failed";
		await log(`workflow ${state}: ${workflowDefinition.name}`, { error });
	} finally {
		runSignal.abort();
		await Promise.allSettled([...trackedSubagents]);
		agentSemaphore.dispose();
		runSignal.dispose();
	}

	const ended = Date.now();
	const resultState: Exclude<WorkflowRunState, "running" | "stale"> =
		state === "completed" || state === "cancelled" ? state : "failed";
	const resultIntegritySnapshot = resultIntegrity();
	const result: WorkflowRunResult = {
		workflow: workflowDefinition.name,
		scope: workflowDefinition.scope,
		file: workflowDefinition.path,
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
		...(resultIntegritySnapshot ? { integrity: resultIntegritySnapshot } : {}),
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
