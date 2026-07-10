/**
 * Arranque en segundo plano de workflows — estado inicial, preferencia de background
 * y registro del run activo. Parte del deep module lifecycle sin cambio de comportamiento.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatRunSummary } from "../lib/run-summary.js";
import {
	formatParallelAgents,
	prepareWorkflowRun,
	runWorkflow,
	writeJsonFile,
	writeRunStatus,
} from "../runtime/index.js";
import type {
	ActiveWorkflowRun,
	PreparedWorkflowRun,
	RunLimits,
	WorkflowDefinition,
	WorkflowRunResult,
	WorkflowRunStatus,
} from "../types.js";
import { notifyWorkflowResult } from "./notify.js";
import { registerActiveRun, unregisterActiveRun } from "./registry.js";
import { shouldSuppressReloadHandoffResult } from "./reload-handoff.js";
import { runtimeWorkflowDeps } from "./runtime-deps.js";
import { refreshActiveWorkflowStatus } from "./status.js";

function initialRunStatus(
	workflow: WorkflowDefinition,
	prepared: PreparedWorkflowRun,
	active: boolean,
	limits?: RunLimits,
): WorkflowRunStatus {
	const now = Date.now();
	return {
		workflow: workflow.name,
		scope: workflow.scope,
		file: workflow.path,
		runId: prepared.runId,
		runDir: prepared.runDir,
		state: "running",
		background: prepared.background,
		active,
		startedAt: new Date(prepared.started).toISOString(),
		updatedAt: new Date(now).toISOString(),
		elapsedMs: now - prepared.started,
		agentCount: 0,
		...(limits
			? {
					agentConcurrency: limits.concurrency,
					maxAgents: limits.maxAgents,
					parallelAgents: 0,
					peakParallelAgents: prepared.resume?.previousPeakParallelAgents ?? 0,
				}
			: {}),
		logs: [],
	};
}

export function formatBackgroundStart(status: WorkflowRunStatus): string {
	return [
		`Started background workflow: ${status.workflow}`,
		`Run: ${status.runId}`,
		`Parallel agents: ${formatParallelAgents(status)}`,
		`Status: ${path.join(status.runDir, "status.json")}`,
		`Artifacts: ${status.runDir}`,
		`View: dynamic_workflow action=view name=${status.runId}`,
		`Cancel: dynamic_workflow action=cancel name=${status.runId}`,
	].join("\n");
}

function canLaunchWorkflowInBackground(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui" || ctx.mode === "rpc";
}

export function shouldLaunchWorkflowInBackground(ctx: ExtensionContext): boolean {
	// Preferencia del proyecto: cada flujo de trabajo lanzado desde una sesión persistente se ejecuta
	// en segundo plano para que el panel siga siendo el plano de control y la finalización pueda
	// despertar al agente. Los modos print/json no tienen sesión en vivo para mantener viva la ejecución.
	return canLaunchWorkflowInBackground(ctx);
}

export async function startWorkflowBackground(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	workflow: WorkflowDefinition,
	input: unknown,
	limits: RunLimits,
	preparedRun?: PreparedWorkflowRun,
): Promise<WorkflowRunStatus> {
	if (!canLaunchWorkflowInBackground(ctx)) {
		throw new Error(
			"Background workflow runs require a persistent TUI/RPC session. In print/json mode, action=run falls back to foreground because there is no live session to keep a background run alive.",
		);
	}
	// Para reanudar, preparedRun reutiliza el runDir/runId existente en su lugar.
	if (!preparedRun) await runtimeWorkflowDeps.preflightWorkflowLaunch(ctx, workflow, input);
	const prepared = preparedRun ?? (await prepareWorkflowRun(ctx, workflow.name, true));
	const controller = new AbortController();
	const active: ActiveWorkflowRun = {
		runId: prepared.runId,
		runDir: prepared.runDir,
		started: prepared.started,
		cwd: ctx.cwd,
		workflowDefinition: workflow,
		limits,
		controller,
	};
	const status = initialRunStatus(workflow, prepared, true, limits);
	let releaseRunStart: (() => void) | undefined;
	let rejectRunStart: ((error: unknown) => void) | undefined;
	const runStartGate = new Promise<void>((resolve, reject) => {
		releaseRunStart = resolve;
		rejectRunStart = reject;
	});
	const promise = runStartGate
		.then(() =>
			runWorkflow(pi, ctx, workflow, input, limits, controller.signal, runtimeWorkflowDeps, undefined, prepared),
		)
		.then(async (result) => {
			if (!shouldSuppressReloadHandoffResult(result)) await notifyWorkflowResult(pi, ctx, result);
			return result;
		})
		.catch(async (err) => {
			const now = Date.now();
			const error = err instanceof Error ? err.stack || err.message : String(err);
			const result: WorkflowRunResult = {
				workflow: workflow.name,
				scope: workflow.scope,
				file: workflow.path,
				runId: prepared.runId,
				runDir: prepared.runDir,
				ok: false,
				state: "failed",
				background: true,
				startedAt: new Date(prepared.started).toISOString(),
				endedAt: new Date(now).toISOString(),
				elapsedMs: now - prepared.started,
				agentCount: 0,
				agentConcurrency: limits.concurrency,
				maxAgents: limits.maxAgents,
				parallelAgents: 0,
				peakParallelAgents: 0,
				logs: [],
				error,
			};
			await writeJsonFile(path.join(prepared.runDir, "result.json"), result);
			await writeRunStatus({
				...initialRunStatus(workflow, prepared, false, limits),
				state: "failed",
				endedAt: new Date(now).toISOString(),
				updatedAt: new Date(now).toISOString(),
				elapsedMs: now - prepared.started,
				error,
			});
			await fs.writeFile(path.join(prepared.runDir, "summary.md"), formatRunSummary(result), "utf8");
			if (!shouldSuppressReloadHandoffResult(result)) {
				await notifyWorkflowResult(pi, ctx, result);
			}
			return result;
		})
		.finally(() => {
			unregisterActiveRun(prepared.runId);
			refreshActiveWorkflowStatus(ctx);
		});
	active.promise = promise;
	registerActiveRun(active);
	try {
		await writeRunStatus(status);
		refreshActiveWorkflowStatus(ctx);
		releaseRunStart?.();
	} catch (err) {
		rejectRunStart?.(err);
		throw err;
	}
	void promise;
	return status;
}
