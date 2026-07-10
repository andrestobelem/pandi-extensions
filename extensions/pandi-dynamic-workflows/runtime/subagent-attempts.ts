/**
 * Fase de ejecución de runSubagent: el loop de intentos (spawn streaming, live-write a
 * artifacts, readback on-disk como source of truth, parse JSON-mode y validación de schema
 * con retries). Extraído de subagent.ts; recibe la invocación ya preparada y el bookkeeping
 * de inicio (id/name/artifacts live) y devuelve el resultado crudo + outputs parseados.
 */

import * as fs from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type createSemaphore, throwIfAborted } from "../lib/concurrency.js";
import { truncate } from "../lib/format.js";
import { extractJsonCandidate } from "../lib/json-extract.js";
import type { normalizeAgentEnvAccess } from "./agent-env-persona.js";
import { createAgentEnvWrapper } from "./agent-env-persona.js";
import { parsePiJsonModeOutput, parsePiJsonModeOutputLenient } from "./agent-output.js";
import { buildAgentProcess } from "./agent-process.js";
import { MAX_AGENT_OUTPUT_IN_RESULT } from "./constants.js";
import { currentWorkflowDepth, WORKFLOW_DEPTH_ENV } from "./depth.js";
import { runStreamingAgentProcess, type StreamingProcessResult } from "./process-spawn.js";
import { formatSchemaRetryPrompt, validateStructuredData } from "./structured-output.js";
import type { InternalAgentOptions } from "./subagent-prepare.js";

type AgentEnvAccess = ReturnType<typeof normalizeAgentEnvAccess>;

export type RunAgentAttemptsDeps = {
	ctx: ExtensionContext;
	agentSemaphore: ReturnType<typeof createSemaphore>;
	bumpParallelAgents: () => void;
	releaseParallelAgents: () => void;
	publishStatus: () => Promise<unknown>;
	log: (message: string, details?: unknown) => Promise<void>;
};

export type RunAgentAttemptsParams = {
	effectiveOptions: InternalAgentOptions;
	resolvedProvider: string | undefined;
	resolvedModel: string | undefined;
	resolvedThinking: string | undefined;
	piCommand: string;
	envAccess: AgentEnvAccess;
	agentTimeoutMs: number;
	effectiveSignal: AbortSignal;
	id: number;
	name: string;
	prompt: string;
	startedAt: number;
	liveStdoutPath: string;
	liveStderrPath: string;
};

export type AgentAttemptsResult = {
	result: StreamingProcessResult | undefined;
	attemptStdout: string;
	fullOutput: string;
	output: string;
	schemaOk: boolean | undefined;
	schemaData: unknown;
	schemaError: string;
	queuedMs: number | undefined;
};

export async function runAgentAttempts(
	deps: RunAgentAttemptsDeps,
	params: RunAgentAttemptsParams,
): Promise<AgentAttemptsResult> {
	const { ctx, agentSemaphore, bumpParallelAgents, releaseParallelAgents, publishStatus, log } = deps;
	const {
		effectiveOptions,
		resolvedProvider,
		resolvedModel,
		resolvedThinking,
		piCommand,
		envAccess,
		agentTimeoutMs,
		effectiveSignal,
		id,
		name,
		prompt,
		startedAt,
		liveStdoutPath,
		liveStderrPath,
	} = params;

	const schema = effectiveOptions.schema;
	const schemaRetries = schema === undefined ? 0 : Math.max(0, Math.floor(effectiveOptions.schemaRetries ?? 2));
	let result: StreamingProcessResult | undefined;
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
		// Live-write machinery vive dentro del loop: cola de appends al artifact stdout/stderr
		// con retención del primer error para que no se caiga en silencio.
		let liveWriteTail: Promise<unknown> = Promise.resolve();
		let liveWriteError: unknown;
		const appendLive = (file: string, chunk: Buffer) => {
			liveWriteTail = liveWriteTail
				.then(() => fs.appendFile(file, chunk))
				.catch((err) => {
					if (liveWriteError === undefined) liveWriteError = err;
				});
		};
		try {
			// (B1) A loser aborted DURING setup (resume cache-hit winner, or concurrency<branches)
			// throws here BEFORE spawning -> no token spend. First statement inside the try so the
			// finally still releases the semaphore (acquire is outside the try).
			throwIfAborted(effectiveSignal);
			await publishStatus();
			attemptWrapper = envAccess.useEnvCommand ? await createAgentEnvWrapper(envAccess) : undefined;
			envWrapper = attemptWrapper;
			attemptStdoutStart = await fs
				.stat(liveStdoutPath)
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
				onStdout: (chunk) => appendLive(liveStdoutPath, chunk),
				onStderr: (chunk) => appendLive(liveStderrPath, chunk),
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
				attemptStdout = (await fs.readFile(liveStdoutPath)).subarray(attemptStdoutStart).toString("utf8");
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

	return { result, attemptStdout, fullOutput, output, schemaOk, schemaData, schemaError, queuedMs };
}
