/**
 * Runner de subagente para dynamic-workflows: cache/journal, spawn, schema retries.
 * Extraído de workflow-engine.ts; el engine provee el host con estado mutable.
 */

import * as fs from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	applyDefaultAgentAccess,
	applyPersonaOptions,
	createAgentEnvWrapper,
	formatAgentAccessMarkdown,
	normalizeAgentEnvAccess,
} from "./agent-env-persona.js";
import { parsePiJsonModeOutput, parsePiJsonModeOutputLenient } from "./agent-output.js";
import { type AsyncMutex, type createSemaphore, throwIfAborted } from "./concurrency-primitives.js";
import { phaseEventFields } from "./event-parser.js";
import { type AgentFocusMetrics, parseAgentFocusMetrics } from "./focus-metrics.js";
import { safeJson, truncate } from "./format.js";
import {
	appendJournalRecord,
	computeCallKey,
	lookupJournalRecord,
	makeJournalRecord,
	normalizeSubagentResultForJournal,
} from "./journal.js";
import { extractJsonCandidate } from "./json-extract.js";
import type { OccurrenceCounter } from "./occurrence-counter.js";
import { runStreamingAgentProcess, type StreamingProcessResult } from "./process-spawn.js";
import { MAX_AGENT_OUTPUT_IN_RESULT, MAX_JOURNALED_STREAM } from "./runtime-constants.js";
import {
	appendSystemPromptOption,
	formatSchemaRetryPrompt,
	makeStructuredOutputSystemPrompt,
	validateStructuredData,
} from "./structured-output.js";
import type { AgentOptions, AgentPhaseInfo, JournalCache, RunLimits, SubagentResult } from "./types.js";
import { buildAgentProcess, hostBinName, sanitizeAgentOpts } from "./workflow-agent-process.js";
import { currentWorkflowDepth, WORKFLOW_DEPTH_ENV } from "./workflow-depth.js";
import { slugify } from "./workflow-resolve.js";
import { makeModelArg, TIER_ALIASES, tierModelTable } from "./workflow-tier-models.js";
import { callSignal } from "./workflow-worker-bridge.js";

const MAX_AGENT_PROMPT_COPY_IN_EVENT = 16_000;

export interface InternalAgentOptions extends AgentOptions {
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

export type RunSubagentContext = {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	runDir: string;
	runLimits: Readonly<RunLimits>;
	runSignal: { signal: AbortSignal };
	journal: JournalCache | undefined;
	occurrences: OccurrenceCounter;
	occAssignMutex: AsyncMutex;
	agentSemaphore: ReturnType<typeof createSemaphore>;
	getAgentCount: () => number;
	bumpAgentCount: () => number;
	getLaunchedAgents: () => number;
	bumpLaunchedAgents: () => void;
	bumpCachedCalls: () => void;
	pushFocus: (focus: AgentFocusMetrics) => void;
	bumpParallelAgents: () => void;
	releaseParallelAgents: () => void;
	getCodeHash: () => string;
	log: (message: string, details?: unknown) => Promise<void>;
	appendEvent: (event: unknown) => Promise<void>;
	writeArtifact: (name: string, data: unknown) => Promise<{ path: string }>;
	publishStatus: () => Promise<unknown>;
	recordAgentIntegrity: (result: SubagentResult) => void;
	getTierEnvWarned: () => boolean;
	setTierEnvWarned: (v: boolean) => void;
};

export async function runSubagent(
	host: RunSubagentContext,
	prompt: string,
	options: InternalAgentOptions = {},
): Promise<SubagentResult> {
	const {
		pi,
		ctx,
		runDir,
		runLimits,
		runSignal,
		journal,
		occurrences,
		occAssignMutex,
		agentSemaphore,
		getAgentCount,
		bumpAgentCount,
		getLaunchedAgents,
		bumpLaunchedAgents,
		bumpCachedCalls,
		pushFocus,
		bumpParallelAgents,
		releaseParallelAgents,
		getCodeHash,
		log,
		appendEvent,
		writeArtifact,
		publishStatus,
		recordAgentIntegrity,
		getTierEnvWarned,
		setTierEnvWarned,
	} = host;
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
			bumpCachedCalls();
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
				...(hit.missingKeys?.length || !envAccess.missingKeys.length ? {} : { missingKeys: envAccess.missingKeys }),
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
	if (getLaunchedAgents() >= runLimits.maxAgents) {
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
			agentCount: getAgentCount(),
			launchedAgents: getLaunchedAgents(),
			...phaseEventFields(phase),
		});
		throw new Error(capMessage);
	}
	bumpLaunchedAgents();
	const id = bumpAgentCount();
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
		if (error && !getTierEnvWarned()) {
			setTierEnvWarned(true);
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
		bumpParallelAgents();
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
				releaseParallelAgents();
				await publishStatus().catch(() => {});
			}
			release();
		}
		throwIfAborted(effectiveSignal);
		attemptStdout = result.stdout;
		if (liveWriteError === undefined) {
			try {
				attemptStdout = (await fs.readFile(liveStdoutArtifact.path)).subarray(attemptStdoutStart).toString("utf8");
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
	pushFocus(focus);
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
			makeJournalRecord({ key, occ, method: "agent", codeHash: getCodeHash(), result: subagent }),
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
