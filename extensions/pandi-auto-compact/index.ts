import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { ARG_COMPLETIONS, resolveCommandValue } from "./command-menu.js";
import { type ContextBarLevel, renderContextBar } from "./context-bar.js";
import {
	buildFastSummaryPrompt,
	CODEX_FAST_SUMMARY_MODEL,
	DEFAULT_FAST_SUMMARY_MODEL,
	DEFAULT_SUMMARY_MAX_INPUT_CHARS,
	DEFAULT_SUMMARY_MAX_TOKENS,
	extractFastSummaryText,
	FAST_SUMMARY_MODEL_FALLBACKS,
	FAST_SUMMARY_REASONING,
} from "./fast-summary.js";
import {
	CODEX_DEFAULT_THRESHOLD_PERCENT,
	DEFAULT_THRESHOLD_PERCENT,
	isCodexModel,
	parseBarSetting,
	parseClearSetting,
	parseFastSummarySetting,
	parseSnapshotKeep,
	parseSnapshotSetting,
	parseSummaryMaxTokens,
	parseThreshold,
	resolveDefaultThresholdPercent,
	resolveToggle,
} from "./settings.js";
import {
	buildSnapshot,
	type CompactionSnapshot,
	selectSnapshotsToPrune,
	snapshotDirFor,
	snapshotFileName,
	sortedSnapshotNames,
} from "./snapshots.js";

// Clave del estado del footer. setStatus usa esta clave para que esta extensión sea dueña de exactamente un espacio.
const STATUS_KEY = "auto-compact";

// Los helpers de ruta/forma/poda de instantáneas viven en ./snapshots.ts. DEFAULT_SNAPSHOT_KEEP
// (usado por el manejador de activate) acota el crecimiento en disco de las instantáneas.
const DEFAULT_SNAPSHOT_KEEP = 20;

export type { CompactionSnapshot };
// Los parsers de configuración viven en ./settings.ts; se reexportan acá para que el bundle compilado siga
// exportando los nombres públicos de parser (la suite de integración los importa).
// Los helpers de ruta/forma/poda de instantáneas viven en ./snapshots.ts; se reexportan para que el bundle compilado
// siga exportando los nombres que importa la suite de integración.
export {
	buildFastSummaryPrompt,
	buildSnapshot,
	CODEX_DEFAULT_THRESHOLD_PERCENT,
	CODEX_FAST_SUMMARY_MODEL,
	DEFAULT_FAST_SUMMARY_MODEL,
	DEFAULT_SUMMARY_MAX_INPUT_CHARS,
	DEFAULT_SUMMARY_MAX_TOKENS,
	DEFAULT_THRESHOLD_PERCENT,
	extractFastSummaryText,
	parseBarSetting,
	parseClearSetting,
	parseFastSummarySetting,
	parseSnapshotKeep,
	parseSnapshotSetting,
	parseSummaryMaxTokens,
	parseThreshold,
	resolveDefaultThresholdPercent,
	selectSnapshotsToPrune,
	snapshotDirFor,
	snapshotFileName,
};

// Centinela embebido en el texto elidido de tool-result. Detectarlo vuelve idempotente a la limpieza
// (un reintento nunca vuelve a limpiar texto ya limpiado) y les deja a los humanos ver salida recortada.
export const CLEARED_SENTINEL = "[pi-auto-compact cleared";

export interface ClearToolResultsOptions {
	/** Mantiene los N tool results más recientes completamente intactos (zona de recencia). */
	keepRecent: number;
	/** Solo elide bloques de texto más largos que esto. */
	minChars: number;
	/** Caracteres del inicio original que se conservan. */
	headChars: number;
	/** Caracteres del final original que se conservan (la "decision tail"). */
	tailChars: number;
}

// Limpieza pura y no mutante de tool-result (research §3b). Devuelve un array NUEVO con el
// TEXTO voluminoso de tool results consumidos y VIEJOS elidido a inicio + marcador + final, o null cuando
// nada cambió. Conserva la identidad del mensaje para todo lo que no toca; mantiene
// toolCallId/toolName/isError y bloques de imagen; CONSERVA los últimos keepRecent resultados y los
// resultados con error (señal de recuperación), y es idempotente vía CLEARED_SENTINEL. Quien llama
// la aplica solo por llamada al LLM — la sesión conserva los originales, así que es efímera
// y totalmente recuperable, nunca destructiva.
export const clearOldToolResults = (messages: readonly unknown[], opts: ClearToolResultsOptions): unknown[] | null => {
	if (!Array.isArray(messages) || messages.length === 0) return null;
	const { keepRecent, minChars, headChars, tailChars } = opts;
	const isToolResult = (m: unknown): m is Record<string, unknown> =>
		!!m && typeof m === "object" && (m as Record<string, unknown>).role === "toolResult";

	const toolResultIdx: number[] = [];
	for (let i = 0; i < messages.length; i++) if (isToolResult(messages[i])) toolResultIdx.push(i);
	if (toolResultIdx.length === 0) return null;

	// Todo salvo los últimos keepRecent tool results se puede limpiar.
	const clearable = toolResultIdx.slice(0, Math.max(0, toolResultIdx.length - Math.max(0, keepRecent)));
	if (clearable.length === 0) return null;
	// Nunca limpies salvo que el inicio+final que conservamos sea estrictamente menor que el texto.
	const minEffective = Math.max(minChars, headChars + tailChars + 1);

	let changed = false;
	const out = messages.slice();
	for (const i of clearable) {
		const msg = messages[i] as Record<string, unknown>;
		if (msg.isError === true) continue; // conserva los fallos completos (señal de recuperación)
		const content = msg.content;
		if (!Array.isArray(content)) continue;
		let blockChanged = false;
		const newContent = content.map((block: unknown) => {
			if (!block || typeof block !== "object") return block;
			const b = block as Record<string, unknown>;
			if (b.type !== "text" || typeof b.text !== "string") return block;
			const text = b.text;
			if (text.length <= minEffective || text.includes(CLEARED_SENTINEL)) return block;
			const head = text.slice(0, headChars);
			const tail = text.slice(text.length - tailChars);
			const removed = text.length - head.length - tail.length;
			const toolName = typeof msg.toolName === "string" ? msg.toolName : "tool";
			blockChanged = true;
			return {
				...b,
				text: `${head}\n\u2026${CLEARED_SENTINEL} ${removed} caracteres de este resultado de ${toolName} para ahorrar contexto; la salida completa se conserva en la sesión y se puede releer]\u2026\n${tail}`,
			};
		});
		if (blockChanged) {
			out[i] = { ...msg, content: newContent };
			changed = true;
		}
	}
	return changed ? out : null;
};

export { ARG_COMPLETIONS, MENU_OPTIONS, THRESHOLD_OPTIONS } from "./command-menu.js";
export type { ContextBar, ContextBarLevel } from "./context-bar.js";
// El menú interactivo de `/auto-compact` (MENU_OPTIONS/THRESHOLD_OPTIONS/
// ARG_COMPLETIONS) y resolveCommandValue viven en ./command-menu.ts; MENU_OPTIONS/
// THRESHOLD_OPTIONS/resolveCommandValue se reexportan para preservar la superficie del bundle.
// El render de la barra de progreso del footer + sus tipos viven en ./context-bar.ts; se reexportan para que
// el bundle siga exportando renderContextBar (la suite de integración lo importa).
export { renderContextBar, resolveCommandValue };

// Nivel de la barra del footer -> token de tema. Los estados urgentes (sobre el umbral / compactando) usan
// `error` para leerse como alerta; `accent` se confundía demasiado fácil con selección/logo.
// Se exporta para que la suite de integración pueda pinear el mapeo.
export const BAR_LEVEL_COLOR: Record<ContextBarLevel, "muted" | "warning" | "error"> = {
	idle: "muted",
	near: "warning",
	over: "error",
	compacting: "error",
};

type SummaryAuth = Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;

interface SummaryModelSelection {
	model: Model<any>;
	auth: Extract<SummaryAuth, { ok: true }>;
	ref: string;
}

const modelRef = (model: { provider?: string; id?: string } | undefined): string | undefined =>
	model?.provider && model.id ? `${model.provider}/${model.id}` : undefined;

const candidateModelRefs = (preferred: string | undefined, current: ExtensionContext["model"]): string[] => {
	const modelSensitiveDefault = isCodexModel(current) ? CODEX_FAST_SUMMARY_MODEL : DEFAULT_FAST_SUMMARY_MODEL;
	const refs = [preferred || modelSensitiveDefault, ...FAST_SUMMARY_MODEL_FALLBACKS, modelRef(current)].filter(
		(ref): ref is string => typeof ref === "string" && ref.trim().length > 0,
	);
	return [...new Set(refs)];
};

const findModelByRef = (ctx: ExtensionContext, ref: string): Model<any> | undefined => {
	const trimmed = ref.trim();
	const slash = trimmed.indexOf("/");
	if (slash > 0) return ctx.modelRegistry?.find?.(trimmed.slice(0, slash), trimmed.slice(slash + 1));
	const providers = [ctx.model?.provider, "anthropic", "openai-codex", "ollama"].filter(
		(provider): provider is string => typeof provider === "string" && provider.length > 0,
	);
	for (const provider of [...new Set(providers)]) {
		const model = ctx.modelRegistry?.find?.(provider, trimmed);
		if (model) return model;
	}
	return undefined;
};

const resolveSummaryModel = async (
	ctx: ExtensionContext,
	preferred: string | undefined,
): Promise<SummaryModelSelection | undefined> => {
	if (!ctx.modelRegistry?.find || !ctx.modelRegistry?.getApiKeyAndHeaders) return undefined;
	for (const ref of candidateModelRefs(preferred, ctx.model)) {
		const model = findModelByRef(ctx, ref);
		if (!model) continue;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok) return { model, auth, ref: modelRef(model) ?? ref };
	}
	return undefined;
};

const serializeCompactionMessages = (
	messages: SessionBeforeCompactEvent["preparation"]["messagesToSummarize"],
): string => {
	try {
		return serializeConversation(convertToLlm(messages));
	} catch {
		return JSON.stringify(messages);
	}
};

export default function autoCompact(pi: ExtensionAPI) {
	let enabled = true;
	let thresholdPercentOverride = parseThreshold(process.env.PI_AUTO_COMPACT_PERCENT);
	let previousPercent: number | null | undefined;
	let previousThresholdPercent: number | undefined;
	let pendingReason: string | undefined;
	let compacting = false;
	let showBar = parseBarSetting(process.env.PI_AUTO_COMPACT_BAR) ?? true;
	// Instantáneas de compactación recuperable: activadas de forma predeterminada; retención acotada por sesión.
	let snapshotsEnabled = parseSnapshotSetting(process.env.PI_AUTO_COMPACT_SNAPSHOT) ?? true;
	const snapshotKeep = parseSnapshotKeep(process.env.PI_AUTO_COMPACT_SNAPSHOT_KEEP) ?? DEFAULT_SNAPSHOT_KEEP;
	// Ruta de la instantánea escrita en el session_before_compact más reciente, a la espera de
	// su resumen en session_compact. La compactación nunca es concurrente, así que alcanza con un espacio.
	let pendingSnapshotPath: string | undefined;
	// Limpieza de tool-result (research §3b): una palanca más barata y EFÍMERA que compactar.
	// Antes de cada llamada al LLM, elide el texto voluminoso de tool results consumidos y VIEJOS; la sesión
	// conserva los originales, así que no es destructiva/recuperable. Arranca en OFF de forma predeterminada
	// (cambia lo que ve el modelo en cada llamada); es independiente del disparador de compactación.
	let clearToolResults = parseClearSetting(process.env.PI_AUTO_COMPACT_CLEAR_TOOL_RESULTS) ?? false;
	// Parser reutilizado de enteros positivos (misma semántica que el presupuesto de instantáneas).
	const clearKeepRecent = parseSnapshotKeep(process.env.PI_AUTO_COMPACT_CLEAR_KEEP_RECENT) ?? 3;
	const clearMinChars = parseSnapshotKeep(process.env.PI_AUTO_COMPACT_CLEAR_MIN_CHARS) ?? 2000;
	const CLEAR_HEAD_CHARS = 200;
	const CLEAR_TAIL_CHARS = 200;
	// Resumen rápido de compactación: reemplaza el summarizer default de Pi cuando puede usar un modelo
	// explícitamente acotado. Si algo falla, el hook no devuelve compaction y Pi usa su camino nativo.
	let fastSummaryEnabled = parseFastSummarySetting(process.env.PI_AUTO_COMPACT_FAST_SUMMARY) ?? true;
	const fastSummaryModelOverride = process.env.PI_AUTO_COMPACT_SUMMARY_MODEL?.trim() || undefined;
	const fastSummaryMaxTokens =
		parseSummaryMaxTokens(process.env.PI_AUTO_COMPACT_SUMMARY_MAX_TOKENS) ?? DEFAULT_SUMMARY_MAX_TOKENS;
	const fastSummaryMaxInputChars =
		parseSummaryMaxTokens(process.env.PI_AUTO_COMPACT_SUMMARY_MAX_INPUT_CHARS) ?? DEFAULT_SUMMARY_MAX_INPUT_CHARS;

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	};

	// Renderiza (o limpia) la barra de progreso del footer. La barra se muestra siempre que la
	// extensión esté habilitada y la barra no esté apagada; si no, se limpia
	// para que una extensión deshabilitada no deje una señal vieja atrás.
	const getThresholdPercent = (ctx: ExtensionContext) =>
		thresholdPercentOverride ?? resolveDefaultThresholdPercent(ctx.model);

	const updateStatusBar = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (!enabled || !showBar) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const bar = renderContextBar({
			percent: ctx.getContextUsage()?.percent ?? null,
			thresholdPercent: getThresholdPercent(ctx),
			compacting,
		});
		if (!bar) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(BAR_LEVEL_COLOR[bar.level], bar.text));
	};

	const triggerCompaction = (ctx: ExtensionContext, reason: string) => {
		if (compacting) return;
		pendingReason = undefined;
		compacting = true;
		notify(ctx, `Compactando el contexto automáticamente: ${reason}`, "info");
		updateStatusBar(ctx);

		ctx.compact({
			onComplete: () => {
				compacting = false;
				// Rearma el disparo por cruce desde el usage POST-compactación, no desde null. Si
				// la compactación no pudo llevar el usage por debajo del umbral (contenido pinned/
				// system grande), resetear a null volvería a cruzarlo en cada turno y entraría en loop.
				previousPercent = ctx.getContextUsage()?.percent ?? null;
				notify(ctx, "Auto-compactación completada", "info");
				updateStatusBar(ctx);
			},
			onError: (error) => {
				compacting = false;
				// Rearma el disparo por cruce: una compactación fallida NO redujo el usage, así que
				// dejar previousPercent en su valor cruzado (>= threshold) mantendría
				// crossedThreshold en false para siempre y deshabilitaría la auto-compactación en silencio durante
				// el resto de la sesión. null rearma para que el próximo turno por encima del umbral
				// reintente; a diferencia de onComplete, esto no puede entrar en un loop cerrado (lo marca
				// agent_end, y se autocorrige cuando desaparece el error transitorio).
				previousPercent = null;
				notify(
					ctx,
					`La auto-compactación falló: ${error.message} — va a reintentar automáticamente en cuanto el uso vuelva a cruzar el umbral.`,
					"error",
				);
				updateStatusBar(ctx);
			},
		});
	};

	const updatePendingCompaction = (ctx: ExtensionContext) => {
		if (!enabled || compacting) return;

		const usage = ctx.getContextUsage();
		const currentPercent = usage?.percent ?? null;
		if (currentPercent === null) return;

		const thresholdPercent = getThresholdPercent(ctx);
		const thresholdChanged = previousThresholdPercent !== undefined && previousThresholdPercent !== thresholdPercent;
		const crossedThreshold =
			thresholdChanged ||
			previousPercent === undefined ||
			previousPercent === null ||
			previousPercent < thresholdPercent;
		previousThresholdPercent = thresholdPercent;
		previousPercent = currentPercent;

		if (!crossedThreshold || currentPercent < thresholdPercent) return;
		pendingReason = `${Math.round(currentPercent)}% >= ${thresholdPercent}%`;
	};

	// Persiste las entradas sin procesar que están por resumirse ANTES de que el resumen con pérdida las reemplace.
	// Totalmente a prueba de fallos: cualquier error se muestra (solo en UI) y se absorbe para que una falla de
	// instantánea nunca pueda bloquear ni cancelar la compactación.
	const writeCompactionSnapshot = (
		ctx: ExtensionContext,
		event: { branchEntries?: unknown[]; reason?: string; willRetry?: boolean },
	) => {
		pendingSnapshotPath = undefined;
		if (!enabled || !snapshotsEnabled) return;
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
			pendingSnapshotPath = file;
			// Poda las más antiguas por encima del presupuesto de retención (el archivo recién escrito es el más nuevo).
			try {
				for (const name of selectSnapshotsToPrune(readdirSync(dir), snapshotKeep)) {
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
			pendingSnapshotPath = undefined;
			notify(
				ctx,
				`No se pudo guardar la instantánea de compactación: ${(err as Error).message} — la compactación continúa sin ella.`,
				"warning",
			);
		}
	};

	// Después de compactar, aplica el resumen con pérdida a la instantánea para que el artifact muestre
	// exactamente qué se descartó Y con qué se reemplazó, y después muestra la ruta recuperable.
	const finalizeCompactionSnapshot = (ctx: ExtensionContext, event: { compactionEntry?: { summary?: string } }) => {
		const file = pendingSnapshotPath;
		pendingSnapshotPath = undefined;
		if (!file) return;
		try {
			const data = JSON.parse(readFileSync(file, "utf8")) as CompactionSnapshot;
			data.summary = event.compactionEntry?.summary ?? "";
			writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
			notify(ctx, `Instantánea de compactación guardada (contexto sin procesar recuperable): ${file}`, "info");
		} catch (err) {
			notify(
				ctx,
				`No se pudo finalizar la instantánea de compactación: ${(err as Error).message} — la instantánea sin procesar en ${file} todavía se puede recuperar, solo falta aplicarle el resumen.`,
				"warning",
			);
		}
	};

	const buildFastCompaction = async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
		if (!enabled || !fastSummaryEnabled || !event.preparation) return undefined;
		try {
			const selected = await resolveSummaryModel(ctx, fastSummaryModelOverride);
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
				maxInputChars: fastSummaryMaxInputChars,
			});
			const options: SimpleStreamOptions = {
				apiKey: selected.auth.apiKey,
				headers: selected.auth.headers,
				env: selected.auth.env,
				maxTokens: fastSummaryMaxTokens,
				signal: event.signal ?? ctx.signal,
			};
			if (selected.model.reasoning) options.reasoning = FAST_SUMMARY_REASONING as SimpleStreamOptions["reasoning"];
			const response = await completeSimple(
				selected.model,
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
							maxTokens: fastSummaryMaxTokens,
							maxInputChars: fastSummaryMaxInputChars,
							inputChars: prompt.inputChars,
							truncated: prompt.truncated,
						},
					},
				},
			};
		} catch (err) {
			notify(
				ctx,
				`El resumen rápido de compactación falló; uso el compactor nativo de Pi: ${(err as Error).message}`,
				"warning",
			);
			return undefined;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		updateStatusBar(ctx);
	});

	// Saca una instantánea en cada camino de compactación (manual /compact, auto-compactación por umbral, recuperación de
	// overflow y el propio ctx.compact() de esta extensión) y, si puede, reemplaza el resumen nativo por uno rápido/acotado.
	pi.on("session_before_compact", async (event, ctx) => {
		writeCompactionSnapshot(ctx, event);
		return await buildFastCompaction(event, ctx);
	});
	pi.on("session_compact", (event, ctx) => {
		finalizeCompactionSnapshot(ctx, event);
	});

	// La limpieza de tool-result corre antes de CADA llamada al LLM y solo afecta el payload de esa llamada;
	// la sesión conserva los originales (efímero + recuperable). A prueba de fallos: nunca arroja,
	// no devuelve nada cuando está deshabilitada o cuando ningún mensaje cambió.
	pi.on("context", (event) => {
		if (!clearToolResults) return;
		try {
			const next = clearOldToolResults(event.messages, {
				keepRecent: clearKeepRecent,
				minChars: clearMinChars,
				headChars: CLEAR_HEAD_CHARS,
				tailChars: CLEAR_TAIL_CHARS,
			});
			if (next) return { messages: next as typeof event.messages };
		} catch {
			/* a prueba de fallos: dejá el contexto sin cambios */
		}
	});

	// turn_end puede dispararse entre llamadas a tools dentro de un turno del assistant. Acá solo marca
	// la compactación como pendiente para no interrumpir el workflow activo.
	pi.on("turn_end", (_event, ctx) => {
		updatePendingCompaction(ctx);
		updateStatusBar(ctx);
	});

	// Compacta después de que el turno del assistant termina por completo. Esto preserva el workflow
	// y aun así compacta antes del próximo pedido del usuario.
	pi.on("agent_end", (_event, ctx) => {
		updatePendingCompaction(ctx);
		if (!enabled) {
			pendingReason = undefined;
			updateStatusBar(ctx);
			return;
		}
		if (!pendingReason) {
			updateStatusBar(ctx);
			return;
		}
		const reason = pendingReason;
		pendingReason = undefined;
		triggerCompaction(ctx, reason);
	});

	pi.registerCommand("auto-compact", {
		description: `Configurá la auto-compactación relativa de contexto (habilitada por default al ${DEFAULT_THRESHOLD_PERCENT}% para Claude/otros modelos, ${CODEX_DEFAULT_THRESHOLD_PERCENT}% para Codex). Corré el comando sin argumentos para elegir una configuración desde un menú, o pasá status|on|off|run|bar [on|off]|summary [on|off]|<1-99 percent>.`,
		getArgumentCompletions: (prefix: string) => {
			const needle = prefix.trim().toLowerCase();
			const items = needle
				? ARG_COMPLETIONS.filter((i) => i.value.toLowerCase().startsWith(needle))
				: ARG_COMPLETIONS;
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const trimmed = (await resolveCommandValue(args, ctx)).trim();
			if (!trimmed || trimmed === "status") {
				const thresholdPercent = getThresholdPercent(ctx);
				const thresholdSource = thresholdPercentOverride === undefined ? "predeterminado" : "personalizado";
				notify(
					ctx,
					`La auto-compactación de contexto está ${enabled ? "habilitada" : "deshabilitada"}; threshold: ${thresholdPercent}% (${thresholdSource}); bar: ${showBar ? "on" : "off"}; summary: ${fastSummaryEnabled ? "on" : "off"} (modelo ${fastSummaryModelOverride ?? (isCodexModel(ctx.model) ? CODEX_FAST_SUMMARY_MODEL : DEFAULT_FAST_SUMMARY_MODEL)}, max ${fastSummaryMaxTokens} tokens); snapshots: ${snapshotsEnabled ? "on" : "off"} (mantiene ${snapshotKeep}); clear-tools: ${clearToolResults ? "on" : "off"} (mantiene ${clearKeepRecent}, >=${clearMinChars} caracteres)`,
					"info",
				);
				return;
			}

			if (trimmed === "enable" || trimmed === "on") {
				enabled = true;
				previousPercent = null;
				pendingReason = undefined;
				notify(ctx, `Auto-compactación de contexto habilitada al ${getThresholdPercent(ctx)}%`, "info");
				updateStatusBar(ctx);
				return;
			}

			if (trimmed === "disable" || trimmed === "off") {
				enabled = false;
				pendingReason = undefined;
				notify(ctx, "Auto-compactación de contexto deshabilitada", "warning");
				updateStatusBar(ctx);
				return;
			}

			if (trimmed === "run" || trimmed === "compact") {
				triggerCompaction(ctx, "comando manual");
				return;
			}

			// `bar` (toggle), `bar on`, `bar off` — controlan la barra de progreso del footer.
			if (trimmed === "bar" || trimmed.startsWith("bar ")) {
				const arg = trimmed.slice("bar ".length).trim();
				const next = resolveToggle(arg, showBar, parseBarSetting);
				if (next === undefined) {
					notify(ctx, "Uso: /auto-compact bar [on|off]", "warning");
					return;
				}
				showBar = next;
				notify(ctx, `Barra de auto-compactación de contexto: ${showBar ? "on" : "off"}`, "info");
				updateStatusBar(ctx);
				return;
			}

			// `snapshots` — lista las instantáneas recuperables recientes de esta sesión (solo lectura).
			if (trimmed === "snapshots") {
				try {
					const dir = snapshotDirFor(ctx.cwd, ctx.sessionManager?.getSessionId?.() ?? "session");
					const files = existsSync(dir) ? sortedSnapshotNames(readdirSync(dir)).reverse() : [];
					if (files.length === 0) {
						notify(ctx, `Todavía no hay instantáneas de compactación (${dir})`, "info");
					} else {
						const top = files.slice(0, 10).map((n) => join(dir, n));
						notify(ctx, `Instantáneas de compactación recientes:\n${top.join("\n")}`, "info");
					}
				} catch (err) {
					notify(ctx, `No se pudieron listar las instantáneas: ${(err as Error).message}`, "warning");
				}
				return;
			}

			// `snapshot` (toggle), `snapshot on`, `snapshot off` — instantáneas de compactación recuperable.
			if (trimmed === "snapshot" || trimmed.startsWith("snapshot ")) {
				const arg = trimmed.slice("snapshot".length).trim();
				const next = resolveToggle(arg, snapshotsEnabled, parseSnapshotSetting);
				if (next === undefined) {
					notify(ctx, "Uso: /auto-compact snapshot [on|off]", "warning");
					return;
				}
				snapshotsEnabled = next;
				notify(ctx, `Instantáneas de auto-compactación de contexto: ${snapshotsEnabled ? "on" : "off"}`, "info");
				return;
			}

			// `clear-tools` (toggle), `clear-tools on`, `clear-tools off` — eliden salidas viejas de tools.
			if (trimmed === "clear-tools" || trimmed.startsWith("clear-tools ")) {
				const arg = trimmed.slice("clear-tools".length).trim();
				const next = resolveToggle(arg, clearToolResults, parseClearSetting);
				if (next === undefined) {
					notify(ctx, "Uso: /auto-compact clear-tools [on|off]", "warning");
					return;
				}
				clearToolResults = next;
				notify(
					ctx,
					`Limpieza de resultados de tools de auto-compactación de contexto: ${clearToolResults ? "on" : "off"}`,
					"info",
				);
				return;
			}

			// `summary` (toggle), `summary on`, `summary off` — resumen rápido/acotado en session_before_compact.
			if (trimmed === "summary" || trimmed.startsWith("summary ")) {
				const arg = trimmed.slice("summary".length).trim();
				const next = resolveToggle(arg, fastSummaryEnabled, parseFastSummarySetting);
				if (next === undefined) {
					notify(ctx, "Uso: /auto-compact summary [on|off]", "warning");
					return;
				}
				fastSummaryEnabled = next;
				notify(
					ctx,
					`Resumen rápido de auto-compactación de contexto: ${fastSummaryEnabled ? "on" : "off"}`,
					"info",
				);
				return;
			}

			const nextThreshold = parseThreshold(trimmed);
			if (nextThreshold === undefined) {
				notify(
					ctx,
					"Uso: /auto-compact [status|on|off|run|bar [on|off]|summary [on|off]|snapshot [on|off]|snapshots|clear-tools [on|off]|<1-99 percent>]",
					"warning",
				);
				return;
			}

			thresholdPercentOverride = nextThreshold;
			previousPercent = null;
			pendingReason = undefined;
			notify(ctx, `Umbral de auto-compactación de contexto configurado a ${thresholdPercentOverride}%`, "info");
			updateStatusBar(ctx);
		},
	});
}
