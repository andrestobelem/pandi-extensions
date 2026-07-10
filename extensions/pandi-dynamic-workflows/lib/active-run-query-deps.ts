/**
 * Holder de consultas al registry de runs activos — tui delega sin importar lifecycle.
 * `lifecycle/runtime-deps.ts` cablea las implementaciones al arranque.
 */

export type ActiveRunQueryDeps = {
	activeRunCount: () => number;
	hasActiveRun: (runId: string) => boolean;
};

let activeRunQueryDeps: ActiveRunQueryDeps | undefined;

export function setActiveRunQueryDeps(deps: ActiveRunQueryDeps): void {
	activeRunQueryDeps = deps;
}

export function requireActiveRunQueryDeps(): ActiveRunQueryDeps {
	if (!activeRunQueryDeps) {
		throw new Error(
			"Active run query deps are not wired. Ensure lifecycle/runtime-deps is loaded before querying active runs from TUI.",
		);
	}
	return activeRunQueryDeps;
}

export function activeRunCount(): number {
	return requireActiveRunQueryDeps().activeRunCount();
}

export function hasActiveRun(runId: string): boolean {
	return requireActiveRunQueryDeps().hasActiveRun(runId);
}
