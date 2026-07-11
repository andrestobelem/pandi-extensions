/**
 * Estado mutable de la sesión y helpers compartidos entre hooks y comando.
 */

import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { clearOldToolResults } from "./clear-tool-results.js";
import { BAR_LEVEL_COLOR, COMPACT_CAR, DEFAULT_SNAPSHOT_KEEP, STATUS_KEY } from "./constants.js";
import { renderContextBar } from "./context-bar.js";
import {
	buildFastSummaryPrompt,
	DEFAULT_SUMMARY_MAX_INPUT_CHARS,
	DEFAULT_SUMMARY_MAX_TOKENS,
	extractFastSummaryText,
	FAST_SUMMARY_REASONING,
} from "./fast-summary.js";
import {
	parseBarSetting,
	parseClearSetting,
	parseFastSummarySetting,
	parseSnapshotKeep,
	parseSnapshotSetting,
	parseSummaryMaxTokens,
	parseThreshold,
	resolveDefaultThresholdPercent,
} from "./settings.js";
import {
	buildSnapshot,
	type CompactionSnapshot,
	selectSnapshotsToPrune,
	snapshotDirFor,
	snapshotFileName,
} from "./snapshots.js";
import { resolveSummaryModel, serializeCompactionMessages } from "./summary-model.js";

export interface AutoCompactRuntime {
	enabled: boolean;
	thresholdPercentOverride: number | undefined;
	previousPercent: number | null | undefined;
	previousThresholdPercent: number | undefined;
	pendingReason: string | undefined;
	compacting: boolean;
	showBar: boolean;
	snapshotsEnabled: boolean;
	snapshotKeep: number;
	pendingSnapshotPath: string | undefined;
	clearToolResults: boolean;
	clearKeepRecent: number;
	clearMinChars: number;
	fastSummaryEnabled: boolean;
	fastSummaryModelOverride: string | undefined;
	fastSummaryMaxTokens: number;
	fastSummaryMaxInputChars: number;
	notify: (ctx: ExtensionContext, message: string, level?: "info" | "warning" | "error") => void;
	getThresholdPercent: (ctx: ExtensionContext) => number;
	updateStatusBar: (ctx: ExtensionContext) => void;
	triggerCompaction: (ctx: ExtensionContext, reason: string) => void;
	updatePendingCompaction: (ctx: ExtensionContext) => void;
	writeCompactionSnapshot: (
		ctx: ExtensionContext,
		event: { branchEntries?: unknown[]; reason?: string; willRetry?: boolean },
	) => void;
	finalizeCompactionSnapshot: (ctx: ExtensionContext, event: { compactionEntry?: { summary?: string } }) => void;
	buildFastCompaction: (
		event: SessionBeforeCompactEvent,
		ctx: ExtensionContext,
	) => Promise<
		| {
				compaction: {
					summary: string;
					firstKeptEntryId: string;
					tokensBefore: number;
					details: Record<string, unknown>;
				};
		  }
		| undefined
	>;
	handleContextHook: (event: { messages: unknown[] }) => { messages: unknown[] } | undefined;
}

const CLEAR_HEAD_CHARS = 200;
const CLEAR_TAIL_CHARS = 200;

export function createAutoCompactRuntime(): AutoCompactRuntime {
	const runtime: AutoCompactRuntime = {
		enabled: true,
		thresholdPercentOverride: parseThreshold(process.env.PI_AUTO_COMPACT_PERCENT),
		previousPercent: undefined,
		previousThresholdPercent: undefined,
		pendingReason: undefined,
		compacting: false,
		showBar: parseBarSetting(process.env.PI_AUTO_COMPACT_BAR) ?? true,
		snapshotsEnabled: parseSnapshotSetting(process.env.PI_AUTO_COMPACT_SNAPSHOT) ?? true,
		snapshotKeep: parseSnapshotKeep(process.env.PI_AUTO_COMPACT_SNAPSHOT_KEEP) ?? DEFAULT_SNAPSHOT_KEEP,
		pendingSnapshotPath: undefined,
		clearToolResults: parseClearSetting(process.env.PI_AUTO_COMPACT_CLEAR_TOOL_RESULTS) ?? false,
		clearKeepRecent: parseSnapshotKeep(process.env.PI_AUTO_COMPACT_CLEAR_KEEP_RECENT) ?? 3,
		clearMinChars: parseSnapshotKeep(process.env.PI_AUTO_COMPACT_CLEAR_MIN_CHARS) ?? 2000,
		fastSummaryEnabled: parseFastSummarySetting(process.env.PI_AUTO_COMPACT_FAST_SUMMARY) ?? true,
		fastSummaryModelOverride: process.env.PI_AUTO_COMPACT_SUMMARY_MODEL?.trim() || undefined,
		fastSummaryMaxTokens:
			parseSummaryMaxTokens(process.env.PI_AUTO_COMPACT_SUMMARY_MAX_TOKENS) ?? DEFAULT_SUMMARY_MAX_TOKENS,
		fastSummaryMaxInputChars:
			parseSummaryMaxTokens(process.env.PI_AUTO_COMPACT_SUMMARY_MAX_INPUT_CHARS) ?? DEFAULT_SUMMARY_MAX_INPUT_CHARS,
		notify: () => undefined,
		getThresholdPercent: () => DEFAULT_SNAPSHOT_KEEP,
		updateStatusBar: () => undefined,
		triggerCompaction: () => undefined,
		updatePendingCompaction: () => undefined,
		writeCompactionSnapshot: () => undefined,
		finalizeCompactionSnapshot: () => undefined,
		buildFastCompaction: async () => undefined,
		handleContextHook: () => undefined,
	};

	runtime.notify = (ctx, message, level = "info") => {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	};

	runtime.getThresholdPercent = (ctx) => runtime.thresholdPercentOverride ?? resolveDefaultThresholdPercent(ctx.model);

	runtime.updateStatusBar = (ctx) => {
		if (!ctx.hasUI) return;
		if (!runtime.enabled || !runtime.showBar) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const bar = renderContextBar({
			percent: ctx.getContextUsage()?.percent ?? null,
			thresholdPercent: runtime.getThresholdPercent(ctx),
			compacting: runtime.compacting,
		});
		if (!bar) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(BAR_LEVEL_COLOR[bar.level], bar.text));
	};

	runtime.triggerCompaction = (ctx, reason) => {
		if (runtime.compacting) return;
		runtime.pendingReason = undefined;
		runtime.compacting = true;
		runtime.notify(ctx, `${COMPACT_CAR}\nCompactando el contexto automáticamente: ${reason}`, "info");
		runtime.updateStatusBar(ctx);

		ctx.compact({
			onComplete: () => {
				runtime.compacting = false;
				runtime.previousPercent = ctx.getContextUsage()?.percent ?? null;
				runtime.notify(ctx, "Auto-compactación completada", "info");
				runtime.updateStatusBar(ctx);
			},
			onError: (error) => {
				runtime.compacting = false;
				runtime.previousPercent = null;
				runtime.notify(
					ctx,
					`La auto-compactación falló: ${error.message} — va a reintentar automáticamente en cuanto el uso vuelva a cruzar el umbral.`,
					"error",
				);
				runtime.updateStatusBar(ctx);
			},
		});
	};

	runtime.updatePendingCompaction = (ctx) => {
		if (!runtime.enabled || runtime.compacting) return;

		const usage = ctx.getContextUsage();
		const currentPercent = usage?.percent ?? null;
		if (currentPercent === null) return;

		const thresholdPercent = runtime.getThresholdPercent(ctx);
		const thresholdChanged =
			runtime.previousThresholdPercent !== undefined && runtime.previousThresholdPercent !== thresholdPercent;
		const crossedThreshold =
			thresholdChanged ||
			runtime.previousPercent === undefined ||
			runtime.previousPercent === null ||
			runtime.previousPercent < thresholdPercent;
		runtime.previousThresholdPercent = thresholdPercent;
		runtime.previousPercent = currentPercent;

		if (!crossedThreshold || currentPercent < thresholdPercent) return;
		runtime.pendingReason = `${Math.round(currentPercent)}% >= ${thresholdPercent}%`;
	};

	runtime.writeCompactionSnapshot = (ctx, event) => {
		runtime.pendingSnapshotPath = undefined;
		if (!runtime.enabled || !runtime.snapshotsEnabled) return;
		try {
			const sessionId = ctx.sessionManager?.getSessionId?.() ?? "session";
			const createdAt = new Date().toISOString();
			const reason = event.reason ?? "compact";
			const dir = snapshotDirFor(ctx.cwd, sessionId);
			const file = join(dir, snapshotFileName(createdAt, reason));
			const snapshot = buildSnapshot({
				sessionId,
				createdAt,
				reason,
				willRetry: !!event.willRetry,
				entries: Array.isArray(event.branchEntries) ? event.branchEntries : [],
			});
			mkdirSync(dir, { recursive: true });
			writeFileSync(file, JSON.stringify(snapshot, null, 2), "utf8");
			runtime.pendingSnapshotPath = file;
			try {
				for (const name of selectSnapshotsToPrune(readdirSync(dir), runtime.snapshotKeep)) {
					try {
						unlinkSync(join(dir, name));
					} catch {
						/* una instantánea que no se pudo borrar es inofensiva; seguí */
					}
				}
			} catch {
				/* falló el listado: salteá la poda en esta vuelta */
			}
		} catch (err) {
			runtime.pendingSnapshotPath = undefined;
			runtime.notify(
				ctx,
				`No se pudo guardar la instantánea de compactación: ${(err as Error).message} — la compactación continúa sin ella.`,
				"warning",
			);
		}
	};

	runtime.finalizeCompactionSnapshot = (ctx, event) => {
		const file = runtime.pendingSnapshotPath;
		runtime.pendingSnapshotPath = undefined;
		if (!file) return;
		try {
			const data = JSON.parse(readFileSync(file, "utf8")) as CompactionSnapshot;
			data.summary = event.compactionEntry?.summary ?? "";
			writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
			runtime.notify(
				ctx,
				`Instantánea de compactación guardada (contexto sin procesar recuperable): ${file}`,
				"info",
			);
		} catch (err) {
			runtime.notify(
				ctx,
				`No se pudo finalizar la instantánea de compactación: ${(err as Error).message} — la instantánea sin procesar en ${file} todavía se puede recuperar, solo falta aplicarle el resumen.`,
				"warning",
			);
		}
	};

	runtime.buildFastCompaction = async (event, ctx) => {
		if (!runtime.enabled || !runtime.fastSummaryEnabled || !event.preparation) return undefined;
		try {
			const selected = await resolveSummaryModel(ctx, runtime.fastSummaryModelOverride);
			if (!selected) return undefined;
			const prep = event.preparation;
			const conversationText = serializeCompactionMessages(prep.messagesToSummarize ?? []);
			const turnPrefixText = prep.turnPrefixMessages?.length
				? serializeCompactionMessages(prep.turnPrefixMessages)
				: undefined;
			const prompt = buildFastSummaryPrompt({
				previousSummary: prep.previousSummary,
				conversationText,
				turnPrefixText,
				customInstructions: event.customInstructions,
				fileOps: prep.fileOps,
				isSplitTurn: prep.isSplitTurn,
				maxInputChars: runtime.fastSummaryMaxInputChars,
			});
			const options: SimpleStreamOptions = {
				apiKey: selected.auth.apiKey,
				headers: selected.auth.headers,
				env: selected.auth.env,
				maxTokens: runtime.fastSummaryMaxTokens,
				signal: event.signal ?? ctx.signal,
			};
			if (selected.model.reasoning) options.reasoning = FAST_SUMMARY_REASONING as SimpleStreamOptions["reasoning"];
			const response = await completeSimple(
				selected.model as Model<any>,
				{ messages: [{ role: "user", content: prompt.prompt, timestamp: 0 }] },
				options,
			);
			if (response.stopReason === "error" || response.stopReason === "aborted") return undefined;
			const summary = extractFastSummaryText(response);
			if (!summary) return undefined;
			return {
				compaction: {
					summary,
					firstKeptEntryId: prep.firstKeptEntryId,
					tokensBefore: prep.tokensBefore,
					details: {
						readFiles: prompt.readFiles,
						modifiedFiles: prompt.modifiedFiles,
						fastSummary: {
							model: selected.ref,
							maxTokens: runtime.fastSummaryMaxTokens,
							maxInputChars: runtime.fastSummaryMaxInputChars,
							inputChars: prompt.inputChars,
							truncated: prompt.truncated,
						},
					},
				},
			};
		} catch (err) {
			runtime.notify(
				ctx,
				`El resumen rápido de compactación falló; uso el compactor nativo de Pi: ${(err as Error).message}`,
				"warning",
			);
			return undefined;
		}
	};

	runtime.handleContextHook = (event) => {
		if (!runtime.clearToolResults) return;
		try {
			const next = clearOldToolResults(event.messages as Parameters<typeof clearOldToolResults>[0], {
				keepRecent: runtime.clearKeepRecent,
				minChars: runtime.clearMinChars,
				headChars: CLEAR_HEAD_CHARS,
				tailChars: CLEAR_TAIL_CHARS,
			});
			if (next) return { messages: next };
		} catch {
			/* a prueba de fallos: dejá el contexto sin cambios */
		}
		return undefined;
	};

	return runtime;
}
