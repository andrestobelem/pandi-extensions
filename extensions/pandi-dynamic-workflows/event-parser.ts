/**
 * Núcleo de parsing de run-events para pandi-dynamic-workflows.
 *
 * Coercers puros de valores, la lógica de merge de agent-monitor y las derivaciones
 * phase/elapsed. El pipeline de lectura events.jsonl -> { logs, agents } vive en
 * event-parser-read.ts y se reexporta desde acá para compatibilidad de imports.
 *
 * Extraído byte-idéntico desde index.ts bajo la red de caracterización
 * run-events-parsing.test.mjs.
 *
 * Los contratos de workflow cruzan desde types.ts como import type (borrados en build).
 */
import type { AgentMonitorModel, AgentMonitorState, AgentPhaseInfo, SubagentResult } from "./types.js";

export interface ParsedPhaseEvent {
	id: number;
	label: string;
	time: string;
	source: "event";
}

export function recordValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function booleanValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

export function metricsValue(value: unknown): AgentMonitorModel["metrics"] | undefined {
	const record = recordValue(value);
	if (!record) return undefined;
	const metrics = {
		...(numberValue(record.turns) === undefined ? {} : { turns: numberValue(record.turns) }),
		...(numberValue(record.inputTokensPeak) === undefined
			? {}
			: { inputTokensPeak: numberValue(record.inputTokensPeak) }),
		...(numberValue(record.outputTokensTotal) === undefined
			? {}
			: { outputTokensTotal: numberValue(record.outputTokensTotal) }),
		...(numberValue(record.totalTokens) === undefined ? {} : { totalTokens: numberValue(record.totalTokens) }),
		...(numberValue(record.costTotal) === undefined ? {} : { costTotal: numberValue(record.costTotal) }),
		...(numberValue(record.toolCalls) === undefined ? {} : { toolCalls: numberValue(record.toolCalls) }),
		...(numberValue(record.toolErrors) === undefined ? {} : { toolErrors: numberValue(record.toolErrors) }),
		...(numberValue(record.autoRetries) === undefined ? {} : { autoRetries: numberValue(record.autoRetries) }),
	};
	return Object.keys(metrics).length ? metrics : undefined;
}

export function phaseEventFields(phase: AgentPhaseInfo | undefined): Partial<SubagentResult> {
	if (!phase || phase.total <= 0) return {};
	return {
		phaseId: phase.id,
		phaseIndex: phase.index,
		phaseTotal: phase.total,
		...(phase.label ? { phaseLabel: phase.label } : {}),
	};
}

// Elapsed live de un agente: usá el valor grabado cuando termina; si no,
// derivalo desde startedAt mientras está running para que la fila avance en vez de mostrar un
// placeholder "elapsed:…" congelado.
export function getAgentElapsedMs(
	agent: Pick<AgentMonitorModel, "state" | "startedAt" | "elapsedMs">,
): number | undefined {
	if (agent.elapsedMs !== undefined) return agent.elapsedMs;
	if (agent.state === "running" && agent.startedAt) {
		const started = new Date(agent.startedAt).getTime();
		if (Number.isFinite(started)) return Math.max(0, Date.now() - started);
	}
	return undefined;
}

export function formatAgentPhase(
	agent: Pick<AgentMonitorModel, "phaseId" | "phaseIndex" | "phaseTotal" | "phaseLabel">,
): string | undefined {
	if (!agent.phaseIndex || !agent.phaseTotal) return undefined;
	const batch = agent.phaseId ? `P${agent.phaseId} ` : "";
	return `${batch}${agent.phaseIndex}/${agent.phaseTotal}`;
}

export function stringArrayValue(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const values = value.filter((item): item is string => typeof item === "string");
	return values.length === value.length ? values : undefined;
}

export function isAgentMonitorState(value: unknown): value is AgentMonitorState {
	return (
		value === "running" || value === "completed" || value === "failed" || value === "cached" || value === "unknown"
	);
}

export function mergeAgentMonitor(
	existing: AgentMonitorModel | undefined,
	patch: Partial<AgentMonitorModel> & { id: number; name: string },
): AgentMonitorModel {
	const existingState = existing?.state;
	const patchState = patch.state;
	const state =
		existingState &&
		(existingState === "completed" || existingState === "failed" || existingState === "cached") &&
		patchState === "running"
			? existingState
			: (patchState ?? existingState ?? "unknown");
	const artifactPath = patch.artifactPath ?? existing?.artifactPath;
	return {
		id: patch.id,
		name: patch.name || existing?.name || `agent-${patch.id}`,
		state,
		...(existing?.startedAt || patch.startedAt ? { startedAt: patch.startedAt ?? existing?.startedAt } : {}),
		...(existing?.endedAt || patch.endedAt ? { endedAt: patch.endedAt ?? existing?.endedAt } : {}),
		...(existing?.elapsedMs !== undefined || patch.elapsedMs !== undefined
			? { elapsedMs: patch.elapsedMs ?? existing?.elapsedMs }
			: {}),
		...(existing?.ok !== undefined || patch.ok !== undefined ? { ok: patch.ok ?? existing?.ok } : {}),
		...(existing?.code !== undefined || patch.code !== undefined ? { code: patch.code ?? existing?.code } : {}),
		...(existing?.killed !== undefined || patch.killed !== undefined
			? { killed: patch.killed ?? existing?.killed }
			: {}),
		...(artifactPath ? { artifactPath } : {}),
		...(existing?.model || patch.model ? { model: patch.model ?? existing?.model } : {}),
		...(existing?.thinking || patch.thinking ? { thinking: patch.thinking ?? existing?.thinking } : {}),
		...(existing?.tools || patch.tools ? { tools: patch.tools ?? existing?.tools } : {}),
		...(existing?.excludeTools || patch.excludeTools
			? { excludeTools: patch.excludeTools ?? existing?.excludeTools }
			: {}),
		...(existing?.skills || patch.skills ? { skills: patch.skills ?? existing?.skills } : {}),
		...(existing?.includeSkills !== undefined || patch.includeSkills !== undefined
			? { includeSkills: patch.includeSkills ?? existing?.includeSkills }
			: {}),
		...(existing?.extensions || patch.extensions ? { extensions: patch.extensions ?? existing?.extensions } : {}),
		...(existing?.includeExtensions !== undefined || patch.includeExtensions !== undefined
			? { includeExtensions: patch.includeExtensions ?? existing?.includeExtensions }
			: {}),
		...(existing?.keys || patch.keys ? { keys: patch.keys ?? existing?.keys } : {}),
		...(existing?.missingKeys || patch.missingKeys
			? { missingKeys: patch.missingKeys ?? existing?.missingKeys }
			: {}),
		...(existing?.isolatedEnv !== undefined || patch.isolatedEnv !== undefined
			? { isolatedEnv: patch.isolatedEnv ?? existing?.isolatedEnv }
			: {}),
		...(existing?.phaseId !== undefined || patch.phaseId !== undefined
			? { phaseId: patch.phaseId ?? existing?.phaseId }
			: {}),
		...(existing?.phaseIndex !== undefined || patch.phaseIndex !== undefined
			? { phaseIndex: patch.phaseIndex ?? existing?.phaseIndex }
			: {}),
		...(existing?.phaseTotal !== undefined || patch.phaseTotal !== undefined
			? { phaseTotal: patch.phaseTotal ?? existing?.phaseTotal }
			: {}),
		...(existing?.phaseLabel || patch.phaseLabel ? { phaseLabel: patch.phaseLabel ?? existing?.phaseLabel } : {}),
		...(existing?.promptPreview || patch.promptPreview
			? { promptPreview: patch.promptPreview ?? existing?.promptPreview }
			: {}),
		...(existing?.promptCopy || patch.promptCopy ? { promptCopy: patch.promptCopy ?? existing?.promptCopy } : {}),
		...(existing?.promptTruncated !== undefined || patch.promptTruncated !== undefined
			? { promptTruncated: patch.promptTruncated ?? existing?.promptTruncated }
			: {}),
		...(existing?.output !== undefined || patch.output !== undefined
			? { output: patch.output ?? existing?.output }
			: {}),
		...(existing?.schemaOk !== undefined || patch.schemaOk !== undefined
			? { schemaOk: patch.schemaOk ?? existing?.schemaOk }
			: {}),
		...(existing?.outputEmpty !== undefined || patch.outputEmpty !== undefined
			? { outputEmpty: patch.outputEmpty ?? existing?.outputEmpty }
			: {}),
		...(existing?.outputTruncated !== undefined || patch.outputTruncated !== undefined
			? { outputTruncated: patch.outputTruncated ?? existing?.outputTruncated }
			: {}),
		...(existing?.stdoutTruncated !== undefined || patch.stdoutTruncated !== undefined
			? { stdoutTruncated: patch.stdoutTruncated ?? existing?.stdoutTruncated }
			: {}),
		...(existing?.outputChars !== undefined || patch.outputChars !== undefined
			? { outputChars: patch.outputChars ?? existing?.outputChars }
			: {}),
		...(existing?.stdoutChars !== undefined || patch.stdoutChars !== undefined
			? { stdoutChars: patch.stdoutChars ?? existing?.stdoutChars }
			: {}),
		...(existing?.metrics || patch.metrics ? { metrics: patch.metrics ?? existing?.metrics } : {}),
		promptAvailable: existing?.promptAvailable === true || patch.promptAvailable === true || !!artifactPath,
	};
}

export type { ParsedRunEvents } from "./event-parser-read.js";
export { readRunEvents, readRunLogEvents } from "./event-parser-read.js";
