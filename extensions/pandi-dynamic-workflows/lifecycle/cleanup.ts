/**
 * Workflow run lifecycle — cancel/delete/cleanup y abort en apagado de sesión.
 * Parte del deep module lifecycle para mantener el módulo principal enfocado en
 * lanzamiento/reanudación en segundo plano y notificación de resultados.
 */
import * as fs from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getRunStatusLabel,
	listLocatedRuns,
	readRunStatus,
	resolveLocatedRun,
	selectRunByKey,
	selectRunsForCleanup,
	writeRunStatus,
} from "../runtime/index.js";
import type { ActiveWorkflowRun, WorkflowRunResult, WorkflowRunState } from "../types.js";
import { activeRunIds, clearActiveRuns, getActiveRun, hasActiveRun, listActiveRuns } from "./registry.js";

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
				const { record: run } = await resolveLocatedRun(ctx, id);
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

export async function deleteWorkflowRun(ctx: ExtensionContext, id: string | undefined): Promise<string> {
	const { record: run, discoveredRunDir } = await resolveLocatedRun(ctx, id);
	if (hasActiveRun(run.runId))
		throw new Error(`Workflow run is active; cancel it before deleting artifacts: ${run.runId}`);
	await fs.rm(discoveredRunDir, { recursive: true, force: false });
	return `Deleted workflow run artifacts: ${run.runId}\nDirectory: ${discoveredRunDir}`;
}

// Número por defecto de ejecuciones de workflow más recientes que `/workflow cleanup` retiene. Fuente única
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
	const locatedRuns = await listLocatedRuns(ctx);
	const runs = locatedRuns.map(({ record }) => record);
	const discoveredRunDirs = new Map(locatedRuns.map(({ record, discoveredRunDir }) => [record, discoveredRunDir]));
	const activeIds = new Set(activeRunIds());
	const keep = opts.keep ?? DEFAULT_CLEANUP_KEEP;
	const selected = selectRunsForCleanup(runs, { keep, states: opts.states, activeIds });
	const kept = runs.length - selected.length;
	if (opts.dryRun) return { removed: selected.map((run) => run.runId), kept };
	const removed: string[] = [];
	for (const run of selected) {
		if (hasActiveRun(run.runId)) continue;
		try {
			const discoveredRunDir = discoveredRunDirs.get(run);
			if (!discoveredRunDir) continue;
			await fs.rm(discoveredRunDir, { recursive: true, force: false });
			removed.push(run.runId);
		} catch {
			// Already gone or lost a race — skip it.
		}
	}
	return { removed, kept: runs.length - removed.length };
}

// Carrera de una promesa contra un tiempo de espera. El temporizador de tiempo de espera siempre se borra después para que
// una promesa que se resuelve rápido no pueda dejar un temporizador pendiente manteniendo vivo el event loop (p. ej.
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
