/**
 * Reload handoff — interrumpe runs activos en /reload y los reanuda en la instancia fresca.
 *
 * Parte del deep module lifecycle sin cambio de comportamiento. El store vive en globalThis
 * para sobrevivir al swap de módulos de la extensión.
 *
 * Import dinámico de resume/notify/cleanup en los entry points para evitar ciclo de carga
 * (lifecycle importa shouldSuppress de acá; acá necesita resume/notify/settle en runtime).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notify } from "../lib/notify.js";
import { refreshActiveWorkflowStatus } from "../tui/index.js";
import type { ActiveWorkflowRun, RunLimits, WorkflowRunResult } from "../types.js";
import { clearActiveRuns, listActiveRuns } from "./registry.js";

const RELOAD_INTERRUPT_REASON =
	"Workflow interrupted by /reload; the new extension instance will resume this run from the journal.";
const RELOAD_HANDOFF_GLOBAL_KEY = "__pandiDynamicWorkflowsReloadHandoff";

interface ReloadHandoffEntry {
	runId: string;
	cwd: string;
	limits: RunLimits;
	settled: Promise<WorkflowRunResult | undefined>;
	settledResult?: WorkflowRunResult;
	interruptedByReload?: boolean;
	resuming?: boolean;
}

function reloadHandoffStore(): Map<string, ReloadHandoffEntry> {
	const g = globalThis as typeof globalThis & {
		__pandiDynamicWorkflowsReloadHandoff?: Map<string, ReloadHandoffEntry>;
	};
	if (!g[RELOAD_HANDOFF_GLOBAL_KEY]) {
		g[RELOAD_HANDOFF_GLOBAL_KEY] = new Map<string, ReloadHandoffEntry>();
	}
	return g[RELOAD_HANDOFF_GLOBAL_KEY];
}

function isReloadInterruptResult(result: WorkflowRunResult | undefined): boolean {
	return typeof result?.error === "string" && result.error.includes(RELOAD_INTERRUPT_REASON);
}

export function shouldSuppressReloadHandoffResult(result: WorkflowRunResult): boolean {
	return reloadHandoffStore().has(result.runId);
}

function makeReloadHandoffSettledPromise(run: ActiveWorkflowRun): Promise<WorkflowRunResult | undefined> {
	return (run.promise ?? Promise.resolve(undefined))
		.then((result) => {
			const entry = reloadHandoffStore().get(run.runId);
			if (entry) {
				if (result) entry.settledResult = result;
				entry.interruptedByReload = isReloadInterruptResult(result);
			}
			return result;
		})
		.catch((err) => {
			const message = err instanceof Error ? err.stack || err.message : String(err);
			const entry = reloadHandoffStore().get(run.runId);
			if (entry) entry.interruptedByReload = message.includes(RELOAD_INTERRUPT_REASON);
			return undefined;
		});
}

async function resolveWithinTimeout<T>(
	work: Promise<T>,
	timeoutMs: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const guard = new Promise<{ timedOut: true }>((resolve) => {
		timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
	});
	try {
		return await Promise.race([work.then((value) => ({ timedOut: false as const, value })), guard]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function interruptActiveWorkflowRunsForReload(): Promise<{ interrupted: string[] }> {
	const { settleWithinTimeout } = await import("./cleanup.js");
	const runs = listActiveRuns();
	if (runs.length === 0) return { interrupted: [] };
	const store = reloadHandoffStore();
	for (const run of runs) {
		const entry: ReloadHandoffEntry = {
			runId: run.runId,
			cwd: run.cwd,
			limits: { ...run.limits },
			settled: Promise.resolve(undefined),
		};
		store.set(run.runId, entry);
		entry.settled = makeReloadHandoffSettledPromise(run);
		run.controller.abort(RELOAD_INTERRUPT_REASON);
	}
	await settleWithinTimeout(Promise.allSettled(runs.map((run) => store.get(run.runId)?.settled)), 3000);
	clearActiveRuns();
	return { interrupted: runs.map((run) => run.runId) };
}

export async function resumeReloadInterruptedWorkflowRuns(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<{ resumed: string[]; settled: string[]; skipped: string[]; failed: string[] }> {
	const { notifyWorkflowResult } = await import("./notify.js");
	const { resumeWorkflow } = await import("./resume.js");
	const store = reloadHandoffStore();
	const entries = [...store.values()].filter((entry) => entry.cwd === ctx.cwd && !entry.resuming);
	for (const entry of entries) entry.resuming = true;
	const resumed: string[] = [];
	const settled: string[] = [];
	const skipped: string[] = [];
	const failed: string[] = [];

	for (const entry of entries) {
		try {
			const handoffResult = await resolveWithinTimeout(entry.settled, 5000);
			const settledResult = (handoffResult.timedOut ? undefined : handoffResult.value) ?? entry.settledResult;
			if (entry.interruptedByReload) {
				const record = await resumeWorkflow(pi, ctx, entry.runId, { limits: entry.limits });
				resumed.push(record.runId);
				continue;
			}
			if (settledResult) {
				settled.push(entry.runId);
				await notifyWorkflowResult(pi, ctx, settledResult);
				continue;
			}
			skipped.push(entry.runId);
		} catch (err) {
			failed.push(`${entry.runId}: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			store.delete(entry.runId);
		}
	}

	if (resumed.length > 0) {
		notify(
			ctx,
			`Resumed ${resumed.length} background workflow${resumed.length === 1 ? "" : "s"} after /reload: ${resumed.join(", ")}`,
			"info",
		);
	}
	if (skipped.length > 0 || failed.length > 0) {
		const parts = [
			...(skipped.length ? [`skipped (not interrupted by reload): ${skipped.join(", ")}`] : []),
			...(failed.length ? [`failed: ${failed.join("; ")}`] : []),
		];
		notify(
			ctx,
			`Some workflow reload handoffs were not auto-resumed (${parts.join("; ")}). Use /workflow resume <runId> to retry manually.`,
			"warning",
		);
	}
	refreshActiveWorkflowStatus(ctx);
	return { resumed, settled, skipped, failed };
}
