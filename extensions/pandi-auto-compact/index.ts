import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAutoCompactCommand } from "./command-handler.js";
import {
	onAgentEnd,
	onContext,
	onSessionBeforeCompact,
	onSessionCompact,
	onSessionStart,
	onTurnEnd,
} from "./hook-handlers.js";
import { createAutoCompactRuntime } from "./runtime.js";

export type { ClearToolResultsOptions } from "./clear-tool-results.js";
export { CLEARED_SENTINEL, clearOldToolResults } from "./clear-tool-results.js";
export { ARG_COMPLETIONS, MENU_OPTIONS, resolveCommandValue, THRESHOLD_OPTIONS } from "./command-menu.js";
export { BAR_LEVEL_COLOR, COMPACT_CAR } from "./constants.js";
export type { ContextBar, ContextBarLevel } from "./context-bar.js";
export { renderContextBar } from "./context-bar.js";
// Los parsers de configuración viven en ./settings.ts; se reexportan acá para que el bundle compilado siga
// exportando los nombres públicos de parser (la suite de integración los importa).
// Los helpers de ruta/forma/poda de instantáneas viven en ./snapshots.ts; se reexportan para que el bundle compilado
// siga exportando los nombres que importa la suite de integración.
// El menú interactivo de `/auto-compact` (MENU_OPTIONS/THRESHOLD_OPTIONS/
// ARG_COMPLETIONS) y resolveCommandValue viven en ./command-menu.ts; MENU_OPTIONS/
// THRESHOLD_OPTIONS/resolveCommandValue se reexportan para preservar la superficie del bundle.
// El render de la barra de progreso del footer + sus tipos viven en ./context-bar.ts; se reexportan para que
// el bundle siga exportando renderContextBar (la suite de integración lo importa).
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

	pi.on("session_start", (event, ctx) => onSessionStart(runtime, event, ctx));

	// Saca una instantánea en cada camino de compactación y, si puede, reemplaza el resumen nativo.
	pi.on("session_before_compact", async (event, ctx) => onSessionBeforeCompact(runtime, event, ctx));
	pi.on("session_compact", (event, ctx) => onSessionCompact(runtime, event, ctx));

	pi.on("context", (event) => {
		const result = onContext(runtime, event);
		if (result) return { messages: result.messages as typeof event.messages };
	});

	pi.on("turn_end", (event, ctx) => onTurnEnd(runtime, event, ctx));
	pi.on("agent_end", (event, ctx) => onAgentEnd(runtime, event, ctx));

	registerAutoCompactCommand(pi, runtime);
}
