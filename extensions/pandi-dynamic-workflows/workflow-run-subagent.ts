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
import { truncate } from "./format.js";
import { computeCallKey } from "./journal.js";
import { extractJsonCandidate } from "./json-extract.js";
import type { OccurrenceCounter } from "./occurrence-counter.js";
import { runStreamingAgentProcess, type StreamingProcessResult } from "./process-spawn.js";
import { MAX_AGENT_OUTPUT_IN_RESULT } from "./runtime-constants.js";
import {
	appendSystemPromptOption,
	formatSchemaRetryPrompt,
	makeStructuredOutputSystemPrompt,
	validateStructuredData,
} from "./structured-output.js";
import type { JournalCache, RunLimits, SubagentResult } from "./types.js";
import { buildAgentProcess, hostBinName, sanitizeAgentOpts } from "./workflow-agent-process.js";
import { currentWorkflowDepth, WORKFLOW_DEPTH_ENV } from "./workflow-depth.js";
import { slugify } from "./workflow-resolve.js";
import { finalizeSubagentResult } from "./workflow-run-subagent-finalize.js";
import {
	type InternalAgentOptions,
	normalizeInternalAgentOptions,
	resolveSubagentModelAndThinking,
	tryReturnCachedSubagent,
} from "./workflow-run-subagent-prepare.js";
import { callSignal } from "./workflow-worker-bridge.js";

export type { InternalAgentOptions } from "./workflow-run-subagent-prepare.js";

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
	const normalized = normalizeInternalAgentOptions(options);
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
	const cachedHit = await tryReturnCachedSubagent(
		{ bumpCachedCalls, recordAgentIntegrity, appendEvent, log },
		{ journal, key, occ, effectiveOptions, phase, envAccess, cacheEnabled },
	);
	if (cachedHit) return cachedHit;
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
	const { resolvedModel, resolvedProvider, resolvedThinking, recordedModel, modelLine, thinkingLine } =
		await resolveSubagentModelAndThinking({
			pi,
			ctx,
			effectiveOptions,
			getTierEnvWarned,
			setTierEnvWarned,
			log,
		});
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
	const elapsedMs = Date.now() - startedAt;
	// Fold this agent's JSON-mode stdout into focus metrics (tokens, tool-error rate,
	// retries) for the per-run observability artifact. Pure + fail-safe; never throws.
	const focus = parseAgentFocusMetrics(attemptStdout, {
		id,
		name,
		ok: result.code === 0 && !result.killed,
		elapsedMs,
	});
	return finalizeSubagentResult(
		{ log, appendEvent, recordAgentIntegrity, pushFocus, writeArtifact, getCodeHash, runDir },
		{
			id,
			name,
			prompt,
			key,
			occ,
			startedAtIso,
			elapsedMs,
			queuedMs,
			result,
			attemptStdout,
			fullOutput,
			output,
			schema,
			schemaOk,
			schemaData,
			schemaError,
			schemaOnInvalid,
			recordedModel,
			resolvedThinking,
			modelLine,
			thinkingLine,
			phaseLine,
			effectiveOptions,
			envAccess,
			accessMarkdown,
			phaseFields,
			artifactName,
			effectiveSignal,
			runSignal: runSignal.signal,
			cacheEnabled,
			agentTimeoutMs,
			focus,
		},
	);
}
