/**
 * Workflow run lifecycle — background launch/resume plus run-status scaffolding.
 * Cancel/delete/cleanup/abort viven en run-lifecycle-cleanup.ts; notificación de
 * resultados en run-lifecycle-notify.ts.
 * Sits between the runWorkflow engine and the command/tool handlers in index.ts.
 *
 * Fully-deferred bidirectional cycle: index.ts imports the lifecycle entry points back
 * (invoked only from handler bodies) and this module reads the active-run registry from
 * handler bodies). Re-exports cleanup helpers for compatibilidad con importadores existentes.
 * Run records come from the run-store / run-state / run-view siblings; workflow contracts
 * cross from types.ts as import type.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildLimits, limitParamsFromInput } from "./config.js";
import { runWorkflowWithUi } from "./dashboard-orchestration.js";
import { computeCodeHash, loadJournal, maxAgentArtifactNumber, maxJournalAgentId } from "./journal.js";
import { notify } from "./notify.js";
import { notifyWorkflowResult } from "./run-lifecycle-notify.js";
import { hasActiveRun, registerActiveRun, unregisterActiveRun } from "./run-registry.js";
import { shouldSuppressReloadHandoffResult } from "./run-reload-handoff.js";
import { formatParallelAgents, getRunPeakParallelAgents, getRunState } from "./run-state.js";
import { formatRunSummary, refreshActiveWorkflowStatus } from "./run-status-ui.js";
import { writeJsonFile, writeRunStatus } from "./run-store.js";
import { resolveRun } from "./run-view.js";
import type {
	ActiveWorkflowRun,
	DynamicWorkflowToolParams,
	PreparedWorkflowRun,
	RunLimits,
	WorkflowDefinition,
	WorkflowLogEntry,
	WorkflowRunRecord,
	WorkflowRunResult,
	WorkflowRunStatus,
} from "./types.js";
import { runWorkflow } from "./workflow-engine.js";
import { preflightWorkflowLaunch } from "./workflow-preflight.js";
import { ensureDir, resolveWorkflow } from "./workflow-resolve.js";
import { prepareWorkflowRun } from "./workflow-run-prepare.js";

export {
	abortActiveWorkflowRuns,
	cancelWorkflowRun,
	cleanupWorkflowRuns,
	DEFAULT_CLEANUP_KEEP,
	deleteWorkflowRun,
	settleWithinTimeout,
} from "./run-lifecycle-cleanup.js";
export { notifyWorkflowResult } from "./run-lifecycle-notify.js";
export {
	interruptActiveWorkflowRunsForReload,
	resumeReloadInterruptedWorkflowRuns,
} from "./run-reload-handoff.js";

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
	if (!preparedRun) await preflightWorkflowLaunch(ctx, workflow, input);
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
		.then(() => runWorkflow(pi, ctx, workflow, input, limits, controller.signal, undefined, prepared))
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

// Reserva síncrona para reanudaciones en vuelo: resumeWorkflow espera varios
// lecturas entre su guardia del registro de runs activos y el momento que startWorkflowBackground /
// runWorkflowWithUi registra la ejecución, así que dos reanudaciones disparadas en el mismo tick
// pasarían ambas la guardia e impulsarían runWorkflow contra el mismo runDir y
// journal (agentes duplicados, aplastamiento de artefactos). El Set se reserva en
// el mismo bloque síncrono que la verificación de guardia y se libera en finally.
const resumingRuns = new Set<string>();

// Reanuda una ejecución interrumpida en su lugar (mismo runDir/runId), reutilizando el journal para que
// las llamadas subagente/bash ya completadas no se re-ejecuten.
export async function resumeWorkflow(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	idOrLatest: string | undefined,
	opts: { background?: boolean; force?: boolean; limits?: Partial<DynamicWorkflowToolParams> } = {},
	signal?: AbortSignal,
	onProgress?: (logs: WorkflowLogEntry[], status?: WorkflowRunStatus) => void,
): Promise<WorkflowRunRecord> {
	const record = await resolveRun(ctx, idOrLatest);
	if (hasActiveRun(record.runId) || resumingRuns.has(record.runId)) {
		throw new Error(`Workflow run is already active: ${record.runId}. Cancel it first or wait for it to finish.`);
	}
	const state = getRunState(record);
	const resumable =
		state === "stale" ||
		state === "failed" ||
		state === "cancelled" ||
		(opts.force === true && state === "completed");
	if (!resumable) {
		if (state === "running")
			throw new Error(`Workflow run ${record.runId} is still running. Cancel it before resuming.`);
		if (state === "completed")
			throw new Error(`Workflow run ${record.runId} already completed. Use force:true to resume it anyway.`);
		throw new Error(`Workflow run ${record.runId} cannot be resumed (state: ${String(state)}).`);
	}

	// Reserva en el MISMO bloque síncrono que la guardia anterior (sin await entre),
	// para que una reanudación concurrente del mismo runId sea rechazada en lugar de ejecutarse dos veces.
	resumingRuns.add(record.runId);
	try {
		return await resumeReservedRun(pi, ctx, record, signal, onProgress, opts.limits);
	} finally {
		resumingRuns.delete(record.runId);
	}
}

// El cuerpo de resumeWorkflow después de validación+reserva (comportamiento sin cambios).
async function resumeReservedRun(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	record: WorkflowRunRecord,
	signal?: AbortSignal,
	onProgress?: (logs: WorkflowLogEntry[], status?: WorkflowRunStatus) => void,
	limitOverrides?: Partial<DynamicWorkflowToolParams>,
): Promise<WorkflowRunRecord> {
	const workflow = await resolveWorkflow(ctx, record.workflow, record.scope);
	const code = await fs.readFile(workflow.path, "utf8");
	const codeHash = computeCodeHash(code);
	const journal = await loadJournal(record.runDir);
	// Comienza agentCount por encima del id más alto ya usado (registrado en el journal O en disco),
	// para que los subagentes recién re-ejecutados nunca puedan sobrescribir un
	// artefacto agents/NNNN existente, incluso cuando el journal es no contiguo o tiene espacios {cache:false}.
	const baseAgentCount = Math.max(maxJournalAgentId(journal), await maxAgentArtifactNumber(record.runDir));

	let input: unknown = {};
	try {
		input = JSON.parse(await fs.readFile(path.join(record.runDir, "input.json"), "utf8"));
	} catch {
		input = {};
	}
	// Los parámetros de límite explícitos pasados a action=resume anulan los derivados de input.json
	// (coincidiendo con la precedencia {...limitParamsFromInput(input), ...params}
	// de la rama start); anteriormente se ignoraban silenciosamente y la ejecución reanudada caía
	// a los valores por defecto — p. ej. reanudar con maxAgents=150 re-ejecutando en el mismo
	// muro DEFAULT_MAX_AGENTS=64 del que fue reanudado para escapar.
	const limits = buildLimits({ ...limitParamsFromInput(input), ...(limitOverrides ?? {}) });
	const resumeInBackground = shouldLaunchWorkflowInBackground(ctx);

	const prepared: PreparedWorkflowRun = {
		started: Number.isFinite(new Date(record.startedAt).getTime())
			? new Date(record.startedAt).getTime()
			: Date.now(),
		runId: record.runId,
		runDir: record.runDir,
		background: resumeInBackground,
		resume: {
			journal,
			baseAgentCount,
			codeHash,
			resumedFrom: record.runId,
			previousPeakParallelAgents: getRunPeakParallelAgents(record) ?? 0,
		},
	};
	await ensureDir(path.join(record.runDir, "agents"));
	// Elimina el result.json obsoleto de la (fallida/cancelada/completada)
	// ejecución anterior. readRunRecord lee result.json antes de status.json, así que dejarlo
	// en su lugar ocultaría el estado en ejecución en vivo durante la duración de la reanudación
	// (runs/view/dashboard mostrarían el estado terminal anterior). runWorkflow
	// reescribe result.json cuando finaliza la ejecución reanudada.
	await fs.rm(path.join(record.runDir, "result.json"), { force: true }).catch(() => {});

	const previousHash = record.codeHash;
	if (previousHash && previousHash !== codeHash) {
		notify(
			ctx,
			`Note: workflow code changed since run ${record.runId} (codeHash ${previousHash.slice(0, 12)} -> ${codeHash.slice(0, 12)}). Calls whose arguments changed will be re-executed (cache miss); unchanged calls stay cached.`,
			"warning",
		);
	}

	if (resumeInBackground) {
		// Returns a WorkflowRunStatus (the run keeps executing in the background).
		return await startWorkflowBackground(pi, ctx, workflow, input, limits, prepared);
	}

	// Print/json fallback: returns a WorkflowRunResult because background cannot stay alive.
	return await runWorkflowWithUi(pi, ctx, workflow, input, limits, signal, onProgress, prepared);
}
