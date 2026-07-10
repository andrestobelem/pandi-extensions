/**
 * Fachada de helpers transversales (format, concurrency, path safety, notify, …).
 * Deep modules import desde acá o desde el módulo hoja concreto cuando evita ciclos.
 */

export {
	AsyncMutex,
	abortReasonMessage,
	type CombinedSignal,
	combineSignal,
	createSemaphore,
	mapLimit,
	sleep,
	throwIfAborted,
} from "./concurrency.js";
export {
	buildLimits,
	DEFAULT_AGENT_TIMEOUT_MS,
	DEFAULT_CONCURRENCY,
	DEFAULT_MAX_AGENTS,
	DEFAULT_SYNC_TIMEOUT_MS,
	DEFAULT_WORKFLOW_TIMEOUT_MS,
	HARD_MAX_AGENTS,
	HARD_MAX_CONCURRENCY,
	limitParamsFromInput,
	normalizeWorkflowInput,
	parseCliJsonOrText,
} from "./config.js";
export { appendFileMutexCount, appendJsonLine } from "./file-append.js";
export { MAX_TOOL_TEXT, safeJson, stringify, text, truncate } from "./format.js";
export { extractJsonCandidate } from "./json-extract.js";
export {
	createMarkdownTheme,
	formatViewerHints,
	pickViewerForPath,
	scrollDelta,
	showMarkdown,
} from "./markdown-view.js";
export { notify } from "./notify.js";
export { OccurrenceCounter } from "./occurrence-counter.js";
export { resolveArtifactPath, resolveCwdPath, resolveInsideRoot } from "./path-safety.js";
export {
	createRunDirectory,
	ensureDir,
	getGraphRoot,
	getRunRoots,
	projectHash,
	slugify,
	WORKFLOW_DIR,
	WORKFLOW_DRAFT_DIR,
	WORKFLOW_GRAPH_DIR,
	WORKFLOW_RUN_DIR,
} from "./paths.js";
export {
	compactInline,
	formatDraftUsageIndex,
	formatElapsedMs,
	formatWorkflowList,
	shortWorkflowName,
	workflowDashboardHint,
	workflowProgress,
	workflowProgressLabel,
} from "./presentation.js";
export {
	type ColorMode,
	colorizeKeyword,
	containsKeywordToken,
	detectColorMode,
} from "./rainbow.js";
export { formatRunSummary } from "./run-summary.js";
export { renderSafeInline, stripAnsiCodes } from "./text-sanitize.js";
export { transformWorkflowCode } from "./transform.js";
