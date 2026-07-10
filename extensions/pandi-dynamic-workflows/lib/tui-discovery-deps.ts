/**
 * Holder de discovery deps para tui — evita tui→lifecycle→surface en tiempo de carga.
 * `lifecycle/runtime-deps.ts` cablea las implementaciones surface al arranque.
 */
import type { TuiWorkflowDiscoveryDeps } from "../runtime/deps.js";

let tuiWorkflowDiscoveryDeps: TuiWorkflowDiscoveryDeps | undefined;

export function setTuiWorkflowDiscoveryDeps(deps: TuiWorkflowDiscoveryDeps): void {
	tuiWorkflowDiscoveryDeps = deps;
}

export function requireTuiWorkflowDiscoveryDeps(): TuiWorkflowDiscoveryDeps {
	if (!tuiWorkflowDiscoveryDeps) {
		throw new Error(
			"TUI workflow discovery deps are not wired. Ensure lifecycle/runtime-deps is loaded before opening the dashboard.",
		);
	}
	return tuiWorkflowDiscoveryDeps;
}
