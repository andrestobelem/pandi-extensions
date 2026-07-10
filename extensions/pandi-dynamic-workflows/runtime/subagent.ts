/**
 * Runner de subagente para dynamic-workflows: orquesta prepare → bookkeeping de inicio →
 * loop de intentos → finalize. Las fases viven en subagent-prepare / subagent-attempts /
 * subagent-finalize; este módulo es la única fachada que el engine ve.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AsyncMutex, createSemaphore } from "../lib/concurrency.js";
import type { OccurrenceCounter } from "../lib/occurrence-counter.js";
import { slugify } from "../lib/paths.js";
import { type AgentFocusMetrics, parseAgentFocusMetrics, phaseEventFields } from "../observe/index.js";
import type { JournalCache, RunLimits, SubagentResult } from "../types.js";
import { hostBinName } from "./agent-process.js";
import { runAgentAttempts } from "./subagent-attempts.js";
import { finalizeSubagentResult } from "./subagent-finalize.js";
import {
	type InternalAgentOptions,
	prepareSubagentInvocation,
	resolveSubagentModelAndThinking,
} from "./subagent-prepare.js";

export type { InternalAgentOptions } from "./subagent-prepare.js";

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
		agentSemaphore,
		bumpAgentCount,
		bumpLaunchedAgents,
		pushFocus,
		log,
		appendEvent,
		writeArtifact,
		getCodeHash,
		recordAgentIntegrity,
		getTierEnvWarned,
		setTierEnvWarned,
	} = host;

	const prepared = await prepareSubagentInvocation(
		{
			ctx,
			runSignal,
			runLimits,
			journal: host.journal,
			occurrences: host.occurrences,
			occAssignMutex: host.occAssignMutex,
			getLaunchedAgents: host.getLaunchedAgents,
			getAgentCount: host.getAgentCount,
			bumpCachedCalls: host.bumpCachedCalls,
			recordAgentIntegrity,
			appendEvent,
			log,
		},
		{ prompt, options },
	);
	if (prepared.kind === "cached") return prepared.result;
	const { effectiveOptions, key, occ, phase, effectiveSignal, envAccess, accessMarkdown, cacheEnabled } =
		prepared.invocation;

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
	const agentTimeoutMs = effectiveOptions.timeoutMs ?? runLimits.agentTimeoutMs;
	const schema = effectiveOptions.schema;
	const schemaOnInvalid = effectiveOptions.schemaOnInvalid ?? "throw";

	const attempts = await runAgentAttempts(
		{
			ctx,
			agentSemaphore,
			bumpParallelAgents: host.bumpParallelAgents,
			releaseParallelAgents: host.releaseParallelAgents,
			publishStatus: host.publishStatus,
			log,
		},
		{
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
			liveStdoutPath: liveStdoutArtifact.path,
			liveStderrPath: liveStderrArtifact.path,
		},
	);

	if (!attempts.result) throw new Error(`Agent did not produce a result: ${name}`);
	const elapsedMs = Date.now() - startedAt;
	// Fold this agent's JSON-mode stdout into focus metrics (tokens, tool-error rate,
	// retries) for the per-run observability artifact. Pure + fail-safe; never throws.
	const focus = parseAgentFocusMetrics(attempts.attemptStdout, {
		id,
		name,
		ok: attempts.result.code === 0 && !attempts.result.killed,
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
			queuedMs: attempts.queuedMs,
			result: attempts.result,
			attemptStdout: attempts.attemptStdout,
			fullOutput: attempts.fullOutput,
			output: attempts.output,
			schema,
			schemaOk: attempts.schemaOk,
			schemaData: attempts.schemaData,
			schemaError: attempts.schemaError,
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
