/**
 * Use-case compartido de resume para la tool `dynamic_workflow` y `/workflow resume`.
 *
 * Evita drift entre superficies: ambas pasan por el mismo contrato hacia
 * resumeWorkflow (force + limits opcionales) y la misma decisión de
 * presentación background vs foreground. Los límites explícitos de la tool
 * (concurrency/maxAgents/…) se forwardean; la CLI puede pasarlos cuando
 * existan (hoy no parsea knobs de límite).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatBackgroundStart, resumeWorkflow, shouldLaunchWorkflowInBackground } from "./lifecycle/index.js";
import { formatRunSummary } from "./run-status-ui.js";
import type { DynamicWorkflowToolParams, WorkflowLogEntry, WorkflowRunResult, WorkflowRunStatus } from "./types.js";

export type ResumePresentation =
	| { kind: "background"; status: WorkflowRunStatus; message: string }
	| { kind: "foreground"; result: WorkflowRunResult; message: string; ok: boolean };

export async function resumeWorkflowForCaller(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runId: string | undefined,
	opts: { force?: boolean; limits?: Partial<DynamicWorkflowToolParams> } = {},
	signal?: AbortSignal,
	onProgress?: (logs: WorkflowLogEntry[]) => void,
): Promise<ResumePresentation> {
	const background = shouldLaunchWorkflowInBackground(ctx);
	const record = await resumeWorkflow(
		pi,
		ctx,
		runId,
		{ background, force: !!opts.force, limits: opts.limits },
		signal,
		onProgress,
	);
	if (background) {
		const status = record as WorkflowRunStatus;
		return { kind: "background", status, message: formatBackgroundStart(status) };
	}
	const result = record as WorkflowRunResult;
	return { kind: "foreground", result, message: formatRunSummary(result), ok: result.ok };
}
