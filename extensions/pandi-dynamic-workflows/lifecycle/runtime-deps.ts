/**
 * Implementaciones surface cableadas al engine — punto único para lifecycle y API pública.
 */
import type { RuntimeWorkflowDeps } from "../runtime/deps.js";
import { preflightWorkflowLaunch, resolveWorkflow } from "../surface/index.js";

export const runtimeWorkflowDeps: RuntimeWorkflowDeps = {
	resolveWorkflow,
	preflightWorkflowLaunch,
};
