/**
 * Implementaciones surface cableadas al engine y tui — único cable surface→lifecycle/tui.
 */

import { setTuiWorkflowDiscoveryDeps } from "../lib/tui-discovery-deps.js";
import type { RuntimeWorkflowDeps, TuiWorkflowDiscoveryDeps } from "../runtime/deps.js";
import { loadWorkflowPatternCode } from "../surface/pattern-scaffolds.js";
import { preflightWorkflowLaunch } from "../surface/preflight.js";
import { listWorkflows, resolveWorkflow, resolveWorkflowForRun } from "../surface/resolve.js";

export const runtimeWorkflowDeps: RuntimeWorkflowDeps = {
	resolveWorkflow,
	preflightWorkflowLaunch,
};

export const tuiWorkflowDiscoveryDeps: TuiWorkflowDiscoveryDeps = {
	listWorkflows,
	resolveWorkflow,
	resolveWorkflowForRun,
	loadWorkflowPatternCode,
};

setTuiWorkflowDiscoveryDeps(tuiWorkflowDiscoveryDeps);
