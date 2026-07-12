/**
 * Fase de preparación de runSubagent: normalización de opciones, resolución de modelo y cache-hit.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AsyncMutex, throwIfAborted } from "../lib/concurrency.js";
import type { OccurrenceCounter } from "../lib/occurrence-counter.js";
import { phaseEventFields } from "../observe/index.js";
import type { AgentOptions, AgentPhaseInfo, JournalCache, RunLimits, SubagentResult } from "../types.js";
import {
	applyDefaultAgentAccess,
	applyPersonaOptions,
	formatAgentAccessMarkdown,
	normalizeAgentEnvAccess,
} from "./agent-env-persona.js";
import { resolveHostThinkingLevel, sanitizeAgentOpts } from "./agent-process.js";
import { computeCallKey, lookupJournalRecord } from "./journal.js";
import { appendSystemPromptOption, makeStructuredOutputSystemPrompt } from "./structured-output.js";
import { makeModelArg, TIER_ALIASES, tierModelTable } from "./tier-models.js";
import { callSignal } from "./worker-bridge.js";

type AgentEnvAccess = ReturnType<typeof normalizeAgentEnvAccess>;

export interface InternalAgentOptions extends AgentOptions {
	/**
	 * Azúcar a nivel de worker. El global agent() del worker mapea effort->thinking y label->name
	 * antes de publicar, pero las especificaciones per-item de agents(), las opciones compartidas de agents() y las llamadas ctx-style
	 * llegan al host sin mapear, así que runSubagent normaliza ambas en la entrada
	 * (effort -> thinking, label -> name) y las elimina (issues #22/#23).
	 */
	effort?: string;
	label?: string;
	__workflowPhase?: AgentPhaseInfo;
	__workflowNamespace?: string;
}

export function normalizeInternalAgentOptions(options: InternalAgentOptions): InternalAgentOptions {
	// Normalize worker-level sugar HOST-SIDE so EVERY path honors it — the worker's agent()
	// global already maps effort->thinking, but agents() per-item specs, agents() shared
	// options, and ctx-style calls arrive unmapped (issue #22: effort was silently dropped
	// while still polluting the cache key). Done BEFORE the persona merge so an explicit
	// per-item effort overrides a persona's thinking default, and BEFORE computeCallKey so
	// the key sees the normalized `thinking` (journals recorded with raw `effort` items no
	// longer match on resume and re-run — accepted, see #22).
	const normalized: InternalAgentOptions = { ...options };
	if (normalized.effort != null) {
		if (normalized.thinking == null) normalized.thinking = String(normalized.effort);
		delete normalized.effort;
	}
	if (normalized.thinking != null) normalized.thinking = resolveHostThinkingLevel(String(normalized.thinking));
	// Same for label -> name (#23): runAgents prefers item.label when naming a spec item, so
	// this mapping covers direct/ctx-style calls; the delete keeps label out of the cache key.
	if (normalized.label != null) {
		if (normalized.name == null) normalized.name = String(normalized.label);
		delete normalized.label;
	}
	return normalized;
}

export type ResolvedSubagentModel = {
	resolvedModel: string | undefined;
	resolvedProvider: string | undefined;
	resolvedThinking: string | undefined;
	recordedModel: string | undefined;
	modelLine: string;
	thinkingLine: string;
};

export type ResolveSubagentModelDeps = {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	effectiveOptions: InternalAgentOptions;
	getTierEnvWarned: () => boolean;
	setTierEnvWarned: (v: boolean) => void;
	log: (message: string, details?: unknown) => Promise<void>;
};

export async function resolveSubagentModelAndThinking(deps: ResolveSubagentModelDeps): Promise<ResolvedSubagentModel> {
	const { pi, ctx, effectiveOptions, getTierEnvWarned, setTierEnvWarned, log } = deps;
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
	return { resolvedModel, resolvedProvider, resolvedThinking, recordedModel, modelLine, thinkingLine };
}

export function buildCachedSubagentHit(
	hit: SubagentResult,
	effectiveOptions: InternalAgentOptions,
	envAccess: AgentEnvAccess,
): SubagentResult {
	return {
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
}

export type TryReturnCachedSubagentDeps = {
	bumpCachedCalls: () => void;
	recordAgentIntegrity: (result: SubagentResult) => void;
	appendEvent: (event: unknown) => Promise<void>;
	log: (message: string, details?: unknown) => Promise<void>;
};

export async function tryReturnCachedSubagent(
	deps: TryReturnCachedSubagentDeps,
	params: {
		journal: JournalCache | undefined;
		key: string;
		occ: number;
		effectiveOptions: InternalAgentOptions;
		phase: AgentPhaseInfo | undefined;
		envAccess: AgentEnvAccess;
		cacheEnabled: boolean;
	},
): Promise<SubagentResult | undefined> {
	const { journal, key, occ, effectiveOptions, phase, envAccess, cacheEnabled } = params;
	if (!cacheEnabled) return undefined;
	const hit = lookupJournalRecord(journal, key, occ);
	if (!hit || !("artifactPath" in hit)) return undefined;
	deps.bumpCachedCalls();
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
	const cachedHit = buildCachedSubagentHit(hit, effectiveOptions, envAccess);
	deps.recordAgentIntegrity(cachedHit);
	await deps.appendEvent({
		type: "agent",
		...cachedHit,
		...phaseEventFields(cachedPhase),
		state: "cached",
		promptAvailable: !!cachedHit.artifactPath,
		stdout: undefined,
		stderr: undefined,
		prompt: undefined,
	});
	await deps.log(`agent cached: ${cachedHit.name}`, {
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

export type PreparedSubagentInvocation = {
	effectiveOptions: InternalAgentOptions;
	key: string;
	occ: number;
	phase: AgentPhaseInfo | undefined;
	effectiveSignal: AbortSignal;
	envAccess: AgentEnvAccess;
	accessMarkdown: string;
	cacheEnabled: boolean;
};

export type PrepareSubagentInvocationDeps = {
	ctx: ExtensionContext;
	runSignal: { signal: AbortSignal };
	runLimits: Readonly<RunLimits>;
	journal: JournalCache | undefined;
	occurrences: OccurrenceCounter;
	occAssignMutex: AsyncMutex;
	getLaunchedAgents: () => number;
	getAgentCount: () => number;
	bumpCachedCalls: () => void;
	recordAgentIntegrity: (result: SubagentResult) => void;
	appendEvent: (event: unknown) => Promise<void>;
	log: (message: string, details?: unknown) => Promise<void>;
};

export type PrepareSubagentInvocationResult =
	| { kind: "cached"; result: SubagentResult }
	| { kind: "prepared"; invocation: PreparedSubagentInvocation };

// Prologue de runSubagent: captura la effectiveSignal sincrónico, resuelve opciones/persona/access
// bajo occAssignMutex (asignando occ en orden de emisión sincrónica para que el journal keyado por
// (key, occ) resume correcto bajo concurrencia), prueba cache-hit y aplica el gate de maxAgents.
// Devuelve el resultado cacheado (early return) o la invocación preparada; el gate de maxAgents
// deja traza de event+log antes de throw para que un drop bajo agents({settle:true}) no sea invisible.
export async function prepareSubagentInvocation(
	deps: PrepareSubagentInvocationDeps,
	params: { prompt: string; options: InternalAgentOptions },
): Promise<PrepareSubagentInvocationResult> {
	const {
		ctx,
		runSignal,
		runLimits,
		journal,
		occurrences,
		occAssignMutex,
		getLaunchedAgents,
		getAgentCount,
		bumpCachedCalls,
		recordAgentIntegrity,
		appendEvent,
		log,
	} = deps;
	const { prompt, options } = params;
	throwIfAborted(runSignal.signal);
	// Captured synchronously at entry so it survives the occAssignMutex/semaphore awaits. For a
	// race() loser this is the per-call signal that an abort-call aborts; for everything else it is
	// the run signal (the dispatcher wraps every agent() call, so a normal call is unchanged).
	const effectiveSignal = callSignal.getStore() ?? runSignal.signal;
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
	if (cachedHit) return { kind: "cached", result: cachedHit };
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
	return {
		kind: "prepared",
		invocation: { effectiveOptions, key, occ, phase, effectiveSignal, envAccess, accessMarkdown, cacheEnabled },
	};
}
