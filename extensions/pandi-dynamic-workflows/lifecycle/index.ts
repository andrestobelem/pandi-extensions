/**
 * Fachada del deep module `lifecycle` — start, resume, cancel, cleanup, notify y registry.
 * Call sites externos importan desde aquí; el interior queda escondido.
 */

export {
	abortActiveWorkflowRuns,
	cancelWorkflowRun,
	cleanupWorkflowRuns,
	DEFAULT_CLEANUP_KEEP,
	deleteWorkflowRun,
	settleWithinTimeout,
} from "./cleanup.js";
export {
	type CleanupAction,
	type CleanupFileEntry,
	type CleanupInventoryItem,
	type CleanupTarget,
	classifyDraftCleanup,
	classifyRunCleanup,
	classifyTmpCleanup,
	cleanupDeletePaths,
	cleanupWorkflowDrafts,
	cleanupWorkflowTmp,
	formatCleanupInventory,
	inventoryWorkflowRuns,
} from "./inventory.js";
export { notifyWorkflowResult } from "./notify.js";
export {
	activeRunCount,
	activeRunIds,
	clearActiveRuns,
	getActiveRun,
	hasActiveRun,
	listActiveRuns,
	registerActiveRun,
	unregisterActiveRun,
} from "./registry.js";
export {
	interruptActiveWorkflowRunsForReload,
	resumeReloadInterruptedWorkflowRuns,
	shouldSuppressReloadHandoffResult,
} from "./reload-handoff.js";
export { resumeWorkflow } from "./resume.js";
export { formatBackgroundStart, shouldLaunchWorkflowInBackground, startWorkflowBackground } from "./start.js";
