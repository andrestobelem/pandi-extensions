import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAutoCompactCommand } from "./command-handler.js";
import { createAutoCompactRuntime } from "./runtime.js";
import { registerAutoCompactHooks } from "./session-hooks.js";

export type { ClearToolResultsOptions } from "./clear-tool-results.js";
export { CLEARED_SENTINEL, clearOldToolResults } from "./clear-tool-results.js";
export { ARG_COMPLETIONS, MENU_OPTIONS, resolveCommandValue, THRESHOLD_OPTIONS } from "./command-menu.js";
export { BAR_LEVEL_COLOR, COMPACT_CAR } from "./constants.js";
export type { ContextBar, ContextBarLevel } from "./context-bar.js";
export { renderContextBar } from "./context-bar.js";
export {
	buildFastSummaryPrompt,
	CODEX_FAST_SUMMARY_MODEL,
	DEFAULT_FAST_SUMMARY_MODEL,
	DEFAULT_SUMMARY_MAX_INPUT_CHARS,
	DEFAULT_SUMMARY_MAX_TOKENS,
	extractFastSummaryText,
} from "./fast-summary.js";
export {
	CODEX_DEFAULT_THRESHOLD_PERCENT,
	DEFAULT_THRESHOLD_PERCENT,
	parseBarSetting,
	parseClearSetting,
	parseFastSummarySetting,
	parseSnapshotKeep,
	parseSnapshotSetting,
	parseSummaryMaxTokens,
	parseThreshold,
	resolveDefaultThresholdPercent,
} from "./settings.js";
export type { CompactionSnapshot } from "./snapshots.js";
export {
	buildSnapshot,
	selectSnapshotsToPrune,
	snapshotDirFor,
	snapshotFileName,
} from "./snapshots.js";

export default function autoCompact(pi: ExtensionAPI) {
	const runtime = createAutoCompactRuntime();
	registerAutoCompactHooks(pi, runtime);
	registerAutoCompactCommand(pi, runtime);
}
