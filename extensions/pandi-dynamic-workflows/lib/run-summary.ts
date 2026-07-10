/**
 * Resumen textual de un WorkflowRunResult — puro, sin dependencia de TUI.
 * Compartido por runtime (summary.md en disco), lifecycle y surface.
 */

import { formatParallelAgents, getRunStatusLabel } from "../runtime/state.js";
import type { WorkflowRunResult } from "../types.js";
import { MAX_TOOL_TEXT, stringify } from "./format.js";

export function formatRunSummary(result: WorkflowRunResult): string {
	const status = getRunStatusLabel(result);
	const parts = [
		`Workflow ${status}: ${result.workflow}`,
		`Run: ${result.runId}`,
		`State: ${status}${result.background ? " (background)" : ""}`,
		`Agents: ${result.agentCount}`,
		`Parallel agents: ${formatParallelAgents(result)}`,
		...(result.integrity
			? [
					`Integrity: failed:${result.integrity.failedAgents} empty-output:${result.integrity.emptyOutputAgents} output:truncated:${result.integrity.outputTruncatedAgents} stdout:truncated:${result.integrity.stdoutTruncatedAgents} timedOut:${result.integrity.timedOutAgents} schemaFailed:${result.integrity.schemaFailedAgents}`,
				]
			: []),
		`Elapsed: ${Math.round(result.elapsedMs / 1000)}s`,
		`Artifacts: ${result.runDir}`,
	];
	if (result.error) parts.push(`Error: ${result.error}`);
	const agentOutputs = result.integrity?.agentOutputs;
	if (agentOutputs) {
		parts.push(
			`Agent output integrity: observed ${agentOutputs.observed}, empty ${agentOutputs.empty}, truncated ${agentOutputs.truncated}, failed ${agentOutputs.failed}`,
		);
	}
	if (result.output !== undefined) parts.push(`\nOutput:\n${stringify(result.output, MAX_TOOL_TEXT)}`);
	return parts.join("\n");
}
