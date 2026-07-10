/**
 * Fachada del deep module `runtime` — engine, API, journal, store, subagent, worker.
 * Call sites externos importan desde aquí; el interior queda escondido.
 */

export { parsePiJsonModeOutput, parsePiJsonModeOutputLenient } from "./agent-output.js";
export type { WorkflowRuntimeApi } from "./api.js";
export {
	EXTENSION_ROOT,
	JOURNAL_FILE,
	MAX_AGENT_OUTPUT_IN_RESULT,
	MAX_JOURNALED_STREAM,
	PI_SESSION_HEARTBEAT_MS,
	PROCESS_KILL_GRACE_MS,
} from "./constants.js";
export type { PreflightWorkflowLaunchFn, RuntimeWorkflowDeps } from "./deps.js";
export { currentWorkflowDepth, maxWorkflowDepth } from "./depth.js";
export { runWorkflow } from "./engine.js";
export {
	appendJournalRecord,
	computeCallKey,
	computeCodeHash,
	JOURNAL_VERSION,
	loadJournal,
	lookupJournalRecord,
	makeJournalRecord,
	maxAgentArtifactNumber,
	maxJournalAgentId,
	normalizeBashResultForJournal,
	normalizeSubagentResultForJournal,
	stableStringify,
} from "./journal.js";
export { prepareWorkflowRun } from "./prepare.js";
export type { ProcessResult, StreamingProcessResult } from "./process-spawn.js";
export { runProcess, runStreamingAgentProcess } from "./process-spawn.js";
export { formatRunList, listRuns, resolveRun, selectRunByKey } from "./runs.js";
export {
	estimatePeakParallelAgents,
	formatParallelAgents,
	formatParallelAgentsCompact,
	getRunAgentConcurrency,
	getRunCachedCalls,
	getRunElapsedMs,
	getRunLogs,
	getRunParallelAgents,
	getRunPeakParallelAgents,
	getRunState,
	getRunStatusIcon,
	getRunStatusLabel,
	isResumableState,
	isRunResult,
	isTerminalRunState,
	selectRunsForCleanup,
} from "./state.js";
export {
	getRunDirs,
	readRunRecord,
	readRunResult,
	readRunStatus,
	writeJsonFile,
	writeRunStatus,
	writeTextFileAtomic,
} from "./store.js";
export { WORKFLOW_WORKER_SOURCE } from "./worker-source.js";
