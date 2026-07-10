import { mapLimit } from "./concurrency-primitives.js";
import type { AgentOptions, AgentPhaseInfo, SubagentResult } from "./types.js";
import { callSignal } from "./workflow-worker-bridge.js";

/** Opciones mínimas que agents() pasa a cada invocación del runner. */
export type AgentRunnerOptions = AgentOptions & {
	__workflowPhase?: AgentPhaseInfo;
	name?: string;
	label?: string;
	effort?: string;
};

export type AgentSpec = AgentRunnerOptions & {
	prompt: string;
};

export type RunAgentsFn = {
	(
		items: (string | AgentSpec)[],
		options?: AgentOptions & { concurrency?: number; settle?: false },
	): Promise<SubagentResult[]>;
	(
		items: (string | AgentSpec)[],
		options: AgentOptions & { concurrency?: number; settle: true },
	): Promise<(SubagentResult | null)[]>;
};

export type MakeRunAgentsDeps = {
	getConcurrencyCap: () => number;
	nextPhaseId: () => number;
	getFanoutSignal: () => AbortSignal;
};

export function makeRunAgents(
	deps: MakeRunAgentsDeps,
	agentRunner: (prompt: string, options?: AgentRunnerOptions) => Promise<SubagentResult>,
): RunAgentsFn {
	async function runAgents(
		items: (string | AgentSpec)[],
		options: AgentOptions & { concurrency?: number; settle?: boolean } = {},
	): Promise<(SubagentResult | null)[]> {
		const concurrencyCap = deps.getConcurrencyCap();
		const concurrency = Math.min(Math.max(Math.floor(options.concurrency ?? concurrencyCap), 1), concurrencyCap);
		const { concurrency: _concurrency, settle = false, ...sharedOptions } = options;
		const phaseId = items.length > 0 ? deps.nextPhaseId() : 0;
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
		const fanoutSignal = deps.getFanoutSignal();
		if (settle) return await mapLimit(items, concurrency, fanoutSignal, runItem, { onError: "null" });
		return await mapLimit(items, concurrency, fanoutSignal, runItem);
	}
	return runAgents as RunAgentsFn;
}
