/**
 * Implementaciones surface cableadas al engine y tui — único cable surface→lifecycle/tui.
 */

import { setActiveRunQueryDeps } from "../lib/active-run-query-deps.js";
import { setTuiWorkflowDiscoveryDeps, type TuiWorkflowDiscoveryDeps } from "../lib/tui-discovery-deps.js";
import type { RuntimeWorkflowDeps } from "../runtime/deps.js";
import { loadWorkflowPatternCode } from "../surface/pattern-scaffolds.js";
import { preflightWorkflowLaunch } from "../surface/preflight.js";
import { listWorkflows, resolveWorkflow, resolveWorkflowForRun } from "../surface/resolve.js";
import { activeRunCount, hasActiveRun } from "./registry.js";

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

setActiveRunQueryDeps({ activeRunCount, hasActiveRun });
