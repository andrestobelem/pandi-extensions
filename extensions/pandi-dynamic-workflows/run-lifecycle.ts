/**
 * Workflow run lifecycle — background launch/resume/cancel/delete plus the run-status
 * scaffolding and shutdown abort. Sits between the runWorkflow engine and the command/tool
 * handlers in index.ts.
 *
 * Fully-deferred bidirectional cycle: index.ts imports the lifecycle entry points back
 * (invoked only from handler bodies) and this module reads the active-run registry from
 * handler bodies) and re-exports settleWithinTimeout for the shutdown test. Run records come
 * from the run-store / run-state / run-view siblings; workflow contracts cross from types.ts as import type.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildLimits, limitParamsFromInput } from "./config.js";
import { runWorkflowWithUi } from "./dashboard-orchestration.js";
import { computeCodeHash, loadJournal, maxAgentArtifactNumber, maxJournalAgentId } from "./journal.js";
import { notify } from "./notify.js";
import {
	activeRunIds,
	clearActiveRuns,
	getActiveRun,
	hasActiveRun,
	listActiveRuns,
	registerActiveRun,
	unregisterActiveRun,
} from "./run-registry.js";
import { shouldSuppressReloadHandoffResult } from "./run-reload-handoff.js";
import { writeRunReport } from "./run-report-writer.js";
import {
	formatParallelAgents,
	getRunPeakParallelAgents,
	getRunState,
	getRunStatusLabel,
	selectRunsForCleanup,
} from "./run-state.js";
import { formatRunSummary, refreshActiveWorkflowStatus } from "./run-status-ui.js";
import { getRunDirs, readRunRecord, readRunStatus, writeJsonFile, writeRunStatus } from "./run-store.js";
import { listRuns, resolveRun, selectRunByKey } from "./run-view.js";
import type {
	ActiveWorkflowRun,
	DynamicWorkflowToolParams,
	PreparedWorkflowRun,
	RunLimits,
	WorkflowDefinition,
	WorkflowLogEntry,
	WorkflowRunRecord,
	WorkflowRunResult,
	WorkflowRunState,
	WorkflowRunStatus,
} from "./types.js";
import { runWorkflow } from "./workflow-engine.js";
import { preflightWorkflowLaunch } from "./workflow-preflight.js";
import { ensureDir, resolveWorkflow } from "./workflow-resolve.js";
import { prepareWorkflowRun } from "./workflow-run-prepare.js";

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

interface FinalReportHandoff {
	reportPath?: string;
	opened?: boolean;
	openCommand?: string;
	error?: string;
}

function makeWorkflowWakePrompt(result: WorkflowRunResult, handoff: FinalReportHandoff = {}): string {
	const state = getRunStatusLabel(result);
	return `Background workflow finished.

Workflow: ${result.workflow}
Run: ${result.runId}
State: ${state}
Artifacts: ${result.runDir}${handoff.reportPath ? `\nFinal report: ${handoff.reportPath}` : ""}${handoff.error ? `\nFinal report error: ${handoff.error}` : ""}

Please inspect the run with dynamic_workflow action=view name=${result.runId}, open the final report if available, read relevant artifacts if needed, and continue the user's task. If the workflow failed, went stale, or produced risks, explain that clearly and propose the next action.`;
}

function wakeAgentForWorkflowResult(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	result: WorkflowRunResult,
	handoff: FinalReportHandoff = {},
): void {
	if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
	if (getRunState(result) === "cancelled") return;
	const prompt = makeWorkflowWakePrompt(result, handoff);
	if (ctx.isIdle()) pi.sendUserMessage(prompt);
	else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

function openCommandForPlatform(platform: NodeJS.Platform, htmlPath: string): { command: string; args: string[] } {
	if (platform === "darwin") return { command: "open", args: [htmlPath] };
	if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", htmlPath] };
	return { command: "xdg-open", args: [htmlPath] };
}

async function openHtmlReportBestEffort(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	reportPath: string,
): Promise<Pick<FinalReportHandoff, "opened" | "openCommand">> {
	if (ctx.mode !== "tui" && ctx.mode !== "rpc") return { opened: false };
	const { command, args } = openCommandForPlatform(process.platform, reportPath);
	const opened = await pi
		.exec(command, args, { cwd: ctx.cwd, timeout: 5000 })
		.then((result) => result.code === 0 && !result.killed)
		.catch(() => false);
	return { opened, openCommand: command };
}

async function writeFinalReportHandoff(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	result: WorkflowRunResult,
): Promise<FinalReportHandoff> {
	try {
		const report = await writeRunReport(result);
		const opened =
			getRunState(result) === "cancelled"
				? { opened: false }
				: await openHtmlReportBestEffort(pi, ctx, report.reportPath);
		return { reportPath: report.reportPath, ...opened };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

export async function notifyWorkflowResult(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	result: WorkflowRunResult,
): Promise<void> {
	const resultState = getRunState(result);
	const type = resultState === "completed" ? "info" : resultState === "cancelled" ? "warning" : "error";
	const handoff = await writeFinalReportHandoff(pi, ctx, result);
	const reportLine = handoff.reportPath
		? `\nFinal report: ${handoff.reportPath}${handoff.opened ? "\nOpened final report in a browser." : ""}`
		: handoff.error
			? `\nFinal report: failed to render (${handoff.error})`
			: "";
	notify(
		ctx,
		`Background workflow ${getRunStatusLabel(result)}: ${result.workflow}\nRun: ${result.runId}\nArtifacts: ${result.runDir}${reportLine}`,
		type,
	);
	wakeAgentForWorkflowResult(pi, ctx, result, handoff);
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

function resolveActiveRun(id: string | undefined): ActiveWorkflowRun | undefined {
	const runs = listActiveRuns().sort((a, b) => b.started - a.started);
	const key = id?.trim();
	if (!key || key === "latest") return runs[0];
	return (
		getActiveRun(key) ??
		selectRunByKey(
			runs,
			key,
			(run) => run.runId,
			(run) => run.workflowDefinition.name,
		)
	);
}

export async function cancelWorkflowRun(ctx: ExtensionContext, id: string | undefined): Promise<string> {
	const active = resolveActiveRun(id);
	if (!active) {
		if (id?.trim()) {
			try {
				const run = await resolveRun(ctx, id);
				return `Workflow run is not active (${getRunStatusLabel(run)}): ${run.runId}`;
			} catch {
				// Fall through to a clearer active-run message.
			}
		}
		throw new Error("No active background workflow run found.");
	}
	active.controller.abort("Workflow cancelled.");
	const existing = await readRunStatus(active.runDir);
	if (existing) {
		const now = Date.now();
		await writeRunStatus({
			...existing,
			state: "cancelled",
			active: false,
			updatedAt: new Date(now).toISOString(),
			endedAt: new Date(now).toISOString(),
			elapsedMs: now - active.started,
			error: "Workflow cancelled.",
		});
	}
	return `Cancellation requested for background workflow run: ${active.runId}`;
}

async function resolveRunForDeletion(
	ctx: ExtensionContext,
	id: string | undefined,
): Promise<{ run: WorkflowRunRecord; runDir: string }> {
	const dirs = await getRunDirs(ctx);
	const records: { run: WorkflowRunRecord; runDir: string }[] = [];
	for (const runDir of dirs) {
		const run = await readRunRecord(runDir);
		if (run) records.push({ run, runDir });
	}
	if (records.length === 0) throw new Error("No workflow runs found.");
	const key = id?.trim() || "latest";
	if (key === "latest") return records[0];
	const found = selectRunByKey(
		records,
		key,
		({ run }) => run.runId,
		({ run }) => run.workflow,
	);
	if (!found) throw new Error(`Workflow run not found: ${key}`);
	return found;
}

export async function deleteWorkflowRun(ctx: ExtensionContext, id: string | undefined): Promise<string> {
	const { run, runDir } = await resolveRunForDeletion(ctx, id);
	if (hasActiveRun(run.runId))
		throw new Error(`Workflow run is active; cancel it before deleting artifacts: ${run.runId}`);
	await fs.rm(runDir, { recursive: true, force: false });
	return `Deleted workflow run artifacts: ${run.runId}\nDirectory: ${runDir}`;
}

// Número por defecto de ejecuciones de flujo de trabajo más recientes que `/workflow cleanup` retiene. Fuente única
// de verdad para la política de retención (re-exportada por command-handlers.ts para el analizador CLI).
export const DEFAULT_CLEANUP_KEEP = 20;

// Limpieza masiva: selecciona las ejecuciones terminales seguras para eliminar (nunca en ejecución/activas, reteniendo
// las `keep` más recientes) y elimina sus directorios de ejecución. `dryRun` devuelve la selección
// sin eliminar para que los llamadores puedan previsualizar. selectRunsForCleanup (run-state.ts) posee
// la política pura; esto la envuelve con el conjunto de runs activos en vivo y la IO fs.rm.
export async function cleanupWorkflowRuns(
	ctx: ExtensionContext,
	opts: { keep?: number; states?: WorkflowRunState[]; dryRun?: boolean } = {},
): Promise<{ removed: string[]; kept: number }> {
	const runs = await listRuns(ctx);
	const activeIds = new Set(activeRunIds());
	const keep = opts.keep ?? DEFAULT_CLEANUP_KEEP;
	const selected = selectRunsForCleanup(runs, { keep, states: opts.states, activeIds });
	const kept = runs.length - selected.length;
	if (opts.dryRun) return { removed: selected.map((run) => run.runId), kept };
	const removed: string[] = [];
	for (const run of selected) {
		if (hasActiveRun(run.runId)) continue;
		try {
			await fs.rm(run.runDir, { recursive: true, force: false });
			removed.push(run.runId);
		} catch {
			// Already gone or lost a race — skip it.
		}
	}
	return { removed, kept: runs.length - removed.length };
}

// Carrera de una promesa contra un tiempo de espera. El temporizador de tiempo de espera siempre se borra después para que
// una promesa que se resuelve rápido no pueda dejar un temporizador pendiente manteniendo vivo el bucle de eventos (p. ej.
// en el apagado de la sesión).
export async function settleWithinTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const guard = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, timeoutMs);
	});
	try {
		await Promise.race([work.then(() => undefined), guard]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function abortActiveWorkflowRuns(reason: string): Promise<void> {
	const promises = listActiveRuns()
		.map((run) => {
			run.controller.abort(reason);
			return run.promise;
		})
		.filter((promise): promise is Promise<WorkflowRunResult> => promise !== undefined);
	if (promises.length === 0) return;
	await settleWithinTimeout(Promise.allSettled(promises), 3000);
	clearActiveRuns();
}
