/**
 * Active workflow run registry.
 *
 * Keeps the mutable in-memory map out of index.ts so sibling modules can observe
 * and update active runs without importing the workflow engine back through a
 * circular runtime edge.
 */
import type { ActiveWorkflowRun } from "./types.js";

const activeRuns = new Map<string, ActiveWorkflowRun>();

export function registerActiveRun(run: ActiveWorkflowRun): void {
	activeRuns.set(run.runId, run);
}

export function unregisterActiveRun(runId: string): boolean {
	return activeRuns.delete(runId);
}

export function getActiveRun(runId: string): ActiveWorkflowRun | undefined {
	return activeRuns.get(runId);
}

export function hasActiveRun(runId: string): boolean {
	return activeRuns.has(runId);
}

export function listActiveRuns(): ActiveWorkflowRun[] {
	return [...activeRuns.values()];
}

export function activeRunIds(): string[] {
	return [...activeRuns.keys()];
}

export function activeRunCount(): number {
	return activeRuns.size;
}

export function clearActiveRuns(): void {
	activeRuns.clear();
}
