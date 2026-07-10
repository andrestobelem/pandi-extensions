/**
 * Run-list kernel (runtime puro): listar, resolver y formatear listados de runs.
 * Presentación (formatRunView, showRunView, viewers) vive en tui/run-view.ts.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	formatParallelAgentsCompact,
	getRunCachedCalls,
	getRunState,
	getRunStatusIcon,
	getRunStatusLabel,
	isResumableState,
} from "../lib/index.js";
import type { WorkflowRunRecord } from "../types.js";
import { getRunDirs, readRunRecord } from "./store.js";

export async function listRuns(ctx: ExtensionContext): Promise<WorkflowRunRecord[]> {
	const runs: WorkflowRunRecord[] = [];
	for (const runDir of await getRunDirs(ctx)) {
		const record = await readRunRecord(runDir);
		if (record) runs.push(record);
	}
	// Ordena por startedAt (más nuevo primero), NO por mtime del directory getRunDirs:
	// status.json se reescribe en cada log()/resume/status refresh, así cualquier write
	// en un OLD run dir bumps su mtime arriba de runs más nuevos — y "latest" es el
	// default target para resume/view/cancel/delete. Matchea ordering de cleanup
	// (run-state.ts). Stable sort: undated records mantienen mtime order, después dated.
	const startedMs = (run: WorkflowRunRecord): number => {
		const t = Date.parse(run.startedAt ?? "");
		return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
	};
	return runs.sort((a, b) => startedMs(b) - startedMs(a));
}

export function formatRunList(runs: WorkflowRunRecord[]): string {
	if (runs.length === 0) return "No workflow runs found.";
	return runs
		.slice(0, 50)
		.map((run) => {
			const bg = run.background ? " bg" : "";
			const state = getRunState(run);
			const active = state === "running" ? " active" : "";
			const resumable = isResumableState(state) ? " resumable" : "";
			const cached = getRunCachedCalls(run) > 0 ? ` cached:${getRunCachedCalls(run)}` : "";
			const parallelCompact = formatParallelAgentsCompact(run);
			const parallel = parallelCompact === "-" ? "" : ` parallel:${parallelCompact}`;
			return `${getRunStatusIcon(run)} ${run.runId} — ${run.workflow}${bg} — ${getRunStatusLabel(run)}${active}${resumable} — ${Math.round(run.elapsedMs / 1000)}s — agents ${run.agentCount}${parallel}${cached}`;
		})
		.join("\n");
}

// Resuelve un run por key con EXACT id match tomando prioridad sobre substring/alias matches,
// así una short exact id nunca puede ser shadowed por un run diferente cuyo id meramente
// contiene la key (que de otra forma cancelaría o borraría el run equivocado).
export function selectRunByKey<T>(
	items: T[],
	key: string,
	idOf: (item: T) => string,
	aliasOf?: (item: T) => string | undefined,
): T | undefined {
	return (
		items.find((item) => idOf(item) === key) ??
		items.find((item) => idOf(item).includes(key) || aliasOf?.(item) === key)
	);
}

export async function resolveRun(ctx: ExtensionContext, id: string | undefined): Promise<WorkflowRunRecord> {
	const runs = await listRuns(ctx);
	if (runs.length === 0) throw new Error("No workflow runs found.");
	const key = id?.trim() || "latest";
	if (key === "latest") return runs[0];
	const found = selectRunByKey(
		runs,
		key,
		(run) => run.runId,
		(run) => run.workflow,
	);
	if (!found) throw new Error(`Workflow run not found: ${key}`);
	return found;
}
