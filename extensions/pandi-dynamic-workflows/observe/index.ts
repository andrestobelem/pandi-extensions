/**
 * Fachada del deep module `observe` — run report, event parsing y focus metrics.
 * Call sites externos importan desde aquí; el interior queda escondido.
 */

export {
	ARTIFACT_VIEWER_FILE,
	buildRunArtifactViewerHtml,
	formatArtifactPreviewText,
} from "./artifact-viewer.js";
export type { RunReportModel } from "./collector.js";
export {
	type CollectRunReportOptions,
	collectRunReport,
	REPORT_BOUNDS,
} from "./collector.js";
export {
	booleanValue,
	formatAgentPhase,
	getAgentElapsedMs,
	isAgentMonitorState,
	mergeAgentMonitor,
	metricsValue,
	numberValue,
	type ParsedPhaseEvent,
	type ParsedRunEvents,
	phaseEventFields,
	readRunEvents,
	readRunLogEvents,
	recordValue,
	stringArrayValue,
	stringValue,
} from "./event-parser.js";
export {
	type AgentFocusMetrics,
	aggregateRunFocusMetrics,
	formatFocusMetricsMarkdown,
	parseAgentFocusMetrics,
	type RunFocusMetrics,
} from "./focus-metrics.js";
export {
	buildRunMermaidSource,
	buildRunReportHtml,
	escapeHtml,
	PANDI_TOKENS_CSS,
	type RunReportAgent,
	type RunReportBasedOn,
	type RunReportText,
	safeRelativeHref,
} from "./html.js";
export { renderRunReportMarkdown } from "./markdown.js";
export {
	RUN_REPORT_WATCH_INTERVAL_MS,
	type RunReportWriteOptions,
	type RunReportWriteResult,
	watchRunReport,
	writeRunReport,
	writeRunReportOnce,
} from "./writer.js";
