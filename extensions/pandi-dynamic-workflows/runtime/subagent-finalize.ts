/**
 * Fase de finalización de runSubagent: artifact final, evento, journal y schema throw.
 */

import { throwIfAborted } from "../lib/concurrency.js";
import { safeJson, truncate } from "../lib/format.js";
import type { AgentFocusMetrics } from "../observe/index.js";
import type { SubagentResult } from "../types.js";
import { MAX_AGENT_OUTPUT_IN_RESULT, MAX_JOURNALED_STREAM } from "./constants.js";
import { appendJournalRecord, makeJournalRecord, normalizeSubagentResultForJournal } from "./journal.js";
import type { StreamingProcessResult } from "./process-spawn.js";
import type { InternalAgentOptions } from "./subagent-prepare.js";

const MAX_AGENT_PROMPT_COPY_IN_EVENT = 16_000;

export type FinalizeSubagentDeps = {
	log: (message: string, details?: unknown) => Promise<void>;
	appendEvent: (event: unknown) => Promise<void>;
	recordAgentIntegrity: (result: SubagentResult) => void;
	pushFocus: (focus: AgentFocusMetrics) => void;
	writeArtifact: (name: string, data: unknown) => Promise<{ path: string }>;
	getCodeHash: () => string;
	runDir: string;
};

export type FinalizeSubagentParams = {
	id: number;
	name: string;
	prompt: string;
	key: string;
	occ: number;
	startedAtIso: string;
	elapsedMs: number;
	queuedMs: number | undefined;
	result: StreamingProcessResult;
	attemptStdout: string;
	fullOutput: string;
	output: string;
	schema: unknown;
	schemaOk: boolean | undefined;
	schemaData: unknown;
	schemaError: string;
	schemaOnInvalid: "throw" | "null";
	recordedModel: string | undefined;
	resolvedThinking: string | undefined;
	modelLine: string;
	thinkingLine: string;
	phaseLine: string;
	effectiveOptions: InternalAgentOptions;
	envAccess: {
		keyNames: string[];
		missingKeys: string[];
		isolatedEnv: boolean;
	};
	accessMarkdown: string;
	phaseFields: Record<string, unknown>;
	artifactName: string;
	effectiveSignal: AbortSignal;
	runSignal: AbortSignal;
	cacheEnabled: boolean;
	agentTimeoutMs: number;
	focus: AgentFocusMetrics;
};

export async function finalizeSubagentResult(
	deps: FinalizeSubagentDeps,
	params: FinalizeSubagentParams,
): Promise<SubagentResult> {
	const { log, appendEvent, recordAgentIntegrity, pushFocus, writeArtifact, getCodeHash, runDir } = deps;
	let schemaData = params.schemaData;
	const {
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
		runSignal,
		cacheEnabled,
		agentTimeoutMs,
		focus,
	} = params;

	if (schema !== undefined && schemaOk !== true && schemaOnInvalid === "null") {
		schemaData = null;
	}
	const schemaShouldThrow = schema !== undefined && schemaOk !== true && schemaOnInvalid !== "null";
	const endedAtIso = new Date().toISOString();
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
	if (effectiveSignal.aborted && !runSignal.aborted)
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
