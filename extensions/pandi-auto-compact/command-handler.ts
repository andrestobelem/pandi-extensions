/**
 * Manejador del slash command `/auto-compact`.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ARG_COMPLETIONS, resolveCommandValue } from "./command-menu.js";
import { CODEX_FAST_SUMMARY_MODEL, DEFAULT_FAST_SUMMARY_MODEL } from "./fast-summary.js";
import type { AutoCompactRuntime } from "./runtime.js";
import {
	CODEX_DEFAULT_THRESHOLD_PERCENT,
	DEFAULT_THRESHOLD_PERCENT,
	isCodexModel,
	parseBarSetting,
	parseClearSetting,
	parseFastSummarySetting,
	parseSnapshotSetting,
	parseThreshold,
	resolveToggle,
} from "./settings.js";
import { snapshotDirFor, sortedSnapshotNames } from "./snapshots.js";

export function registerAutoCompactCommand(pi: ExtensionAPI, runtime: AutoCompactRuntime): void {
	pi.registerCommand("auto-compact", {
		description: `Configurá la auto-compactación relativa de contexto (habilitada por defecto al ${DEFAULT_THRESHOLD_PERCENT}% para Claude/otros modelos, ${CODEX_DEFAULT_THRESHOLD_PERCENT}% para Codex). Corré el comando sin argumentos para elegir una configuración desde un menú, o pasá status|on|off|run|bar [on|off]|summary [on|off]|<1-99 percent>.`,
		getArgumentCompletions: (prefix: string) => {
			const needle = prefix.trim().toLowerCase();
			const items = needle
				? ARG_COMPLETIONS.filter((i) => i.value.toLowerCase().startsWith(needle))
				: ARG_COMPLETIONS;
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			await handleAutoCompactCommand(runtime, args, ctx);
		},
	});
}

async function handleAutoCompactCommand(
	runtime: AutoCompactRuntime,
	args: string,
	ctx: ExtensionContext,
): Promise<void> {
	const trimmed = (await resolveCommandValue(args, ctx)).trim();
	if (!trimmed || trimmed === "status") {
		const thresholdPercent = runtime.getThresholdPercent(ctx);
		const thresholdSource = runtime.thresholdPercentOverride === undefined ? "predeterminado" : "personalizado";
		runtime.notify(
			ctx,
			`La auto-compactación de contexto está ${runtime.enabled ? "habilitada" : "deshabilitada"}; umbral: ${thresholdPercent}% (${thresholdSource}); barra (bar): ${runtime.showBar ? "on" : "off"}; resumen (summary): ${runtime.fastSummaryEnabled ? "on" : "off"} (modelo ${runtime.fastSummaryModelOverride ?? (isCodexModel(ctx.model) ? CODEX_FAST_SUMMARY_MODEL : DEFAULT_FAST_SUMMARY_MODEL)}, máximo ${runtime.fastSummaryMaxTokens} tokens); instantáneas (snapshot): ${runtime.snapshotsEnabled ? "on" : "off"} (mantiene ${runtime.snapshotKeep}); limpieza de tools (clear-tools): ${runtime.clearToolResults ? "on" : "off"} (mantiene ${runtime.clearKeepRecent}, >=${runtime.clearMinChars} caracteres)`,
			"info",
		);
		return;
	}

	if (trimmed === "enable" || trimmed === "on") {
		runtime.enabled = true;
		runtime.previousPercent = null;
		runtime.pendingReason = undefined;
		runtime.notify(ctx, `Auto-compactación de contexto habilitada al ${runtime.getThresholdPercent(ctx)}%`, "info");
		runtime.updateStatusBar(ctx);
		return;
	}

	if (trimmed === "disable" || trimmed === "off") {
		runtime.enabled = false;
		runtime.pendingReason = undefined;
		runtime.notify(ctx, "Auto-compactación de contexto deshabilitada", "warning");
		runtime.updateStatusBar(ctx);
		return;
	}

	if (trimmed === "run" || trimmed === "compact") {
		runtime.triggerCompaction(ctx, "comando manual");
		return;
	}

	const applyToggle = (
		keyword: string,
		current: boolean,
		parser: (raw: string | undefined) => boolean | undefined,
		setter: (next: boolean) => void,
		label: string,
		afterEffect?: () => void,
	): boolean => {
		if (trimmed !== keyword && !trimmed.startsWith(`${keyword} `)) return false;
		const arg = trimmed.slice(keyword.length).trim();
		const next = resolveToggle(arg, current, parser);
		if (next === undefined) {
			runtime.notify(ctx, `Uso: /auto-compact ${keyword} [on|off]`, "warning");
			return true;
		}
		setter(next);
		runtime.notify(ctx, `${label}: ${next ? "on" : "off"}`, "info");
		afterEffect?.();
		return true;
	};

	if (
		applyToggle(
			"bar",
			runtime.showBar,
			parseBarSetting,
			(next) => {
				runtime.showBar = next;
			},
			"Barra de auto-compactación de contexto",
			() => runtime.updateStatusBar(ctx),
		)
	)
		return;

	if (trimmed === "snapshots") {
		try {
			const dir = snapshotDirFor(ctx.cwd, ctx.sessionManager?.getSessionId?.() ?? "session");
			const files = existsSync(dir) ? sortedSnapshotNames(readdirSync(dir)).reverse() : [];
			if (files.length === 0) {
				runtime.notify(ctx, `Todavía no hay instantáneas de compactación (${dir})`, "info");
			} else {
				const top = files.slice(0, 10).map((n) => join(dir, n));
				runtime.notify(ctx, `Instantáneas de compactación recientes:\n${top.join("\n")}`, "info");
			}
		} catch (err) {
			runtime.notify(ctx, `No se pudieron listar las instantáneas: ${(err as Error).message}`, "warning");
		}
		return;
	}

	if (
		applyToggle(
			"snapshot",
			runtime.snapshotsEnabled,
			parseSnapshotSetting,
			(next) => {
				runtime.snapshotsEnabled = next;
			},
			"Instantáneas de auto-compactación de contexto",
		)
	)
		return;

	if (
		applyToggle(
			"clear-tools",
			runtime.clearToolResults,
			parseClearSetting,
			(next) => {
				runtime.clearToolResults = next;
			},
			"Limpieza de resultados de tools de auto-compactación de contexto",
		)
	)
		return;

	if (
		applyToggle(
			"summary",
			runtime.fastSummaryEnabled,
			parseFastSummarySetting,
			(next) => {
				runtime.fastSummaryEnabled = next;
			},
			"Resumen rápido de auto-compactación de contexto",
		)
	)
		return;

	const nextThreshold = parseThreshold(trimmed);
	if (nextThreshold === undefined) {
		runtime.notify(
			ctx,
			"Uso: /auto-compact [status|on|off|run|bar [on|off]|summary [on|off]|snapshot [on|off]|snapshots|clear-tools [on|off]|<1-99 percent>]",
			"warning",
		);
		return;
	}

	runtime.thresholdPercentOverride = nextThreshold;
	runtime.previousPercent = null;
	runtime.pendingReason = undefined;
	runtime.notify(
		ctx,
		`Umbral de auto-compactación de contexto configurado a ${runtime.thresholdPercentOverride}%`,
		"info",
	);
	runtime.updateStatusBar(ctx);
}
