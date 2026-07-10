/**
 * Reanudación de workflow runs — resumeWorkflow y cuerpo post-validación.
 * Sits between the runWorkflow engine and the command/tool handlers in index.ts.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildLimits, limitParamsFromInput } from "../lib/config.js";
import { notify } from "../lib/notify.js";
import {
	computeCodeHash,
	getRunPeakParallelAgents,
	getRunState,
	loadJournal,
	maxAgentArtifactNumber,
	maxJournalAgentId,
} from "../runtime/index.js";
import { ensureDir, resolveWorkflow } from "../surface/index.js";
import { resolveRun, runWorkflowWithUi } from "../tui/index.js";
import type {
	DynamicWorkflowToolParams,
	PreparedWorkflowRun,
	WorkflowLogEntry,
	WorkflowRunRecord,
	WorkflowRunStatus,
} from "../types.js";
import { hasActiveRun } from "./registry.js";
import { shouldLaunchWorkflowInBackground, startWorkflowBackground } from "./start.js";

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
