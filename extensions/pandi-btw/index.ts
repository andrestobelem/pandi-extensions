/**
 * Claude-style `/btw` command for Pi.
 *
 * Claude Code's `/btw <question>` asks a quick SIDE question that uses the current
 * conversation as context, returns a single answer with NO tool access, and is NEVER
 * added to the conversation history — it appears in a dismissible overlay. It is meant
 * for "what did we decide?" / "what file was that?" lookups about context the model
 * already has, not for tasks needing new file reads, commands, or web searches.
 *
 * This extension replicates that in Pi:
 *
 *   /btw what did we decide about auth?   -> one-shot model call over the current branch,
 *                                            answer shown in a scrollable overlay, nothing
 *                                            written back to the session.
 *
 * How it stays out of history: a command handler runs immediately when the user submits
 * `/btw …` (the typed text is not appended to the session), we only READ the branch via
 * sessionManager.getBranch(), and we display the answer with ctx.ui (overlay/notify/console)
 * — we never call pi.sendMessage, pi.appendEntry, pi.setSessionName, or any session write.
 *
 * The request is built with completeSimple() and carries NO tools, so the model can only
 * answer in text. The pure request/answer logic lives in ./build-btw-context; the overlay
 * lives in ./answer-overlay; this file is just orchestration.
 */

import type { AssistantMessage, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { openAnswerOverlay } from "./answer-overlay.js";
import { buildBtwContext, extractAnswerText } from "./build-btw-context.js";

/** Cap the side answer: it should be a quick reply, not a long generation. */
const BTW_MAX_TOKENS = 2048;

const STATUS_KEY = "btw";

/** Notify the user, degrading gracefully outside the TUI (mirrors pi-mdview's helper). */
function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	// The overlay/notify surface only exists in an interactive (TUI/RPC) session. In print
	// AND json (headless, hasUI=false) modes there is no UI, so fall back to the console —
	// otherwise errors/warnings are silently dropped in json mode (a failure then looks
	// indistinguishable from a hang).
	if (ctx.mode !== "print" && ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	if (type === "info") console.log(message);
	else console.error(message);
}

async function handleBtw(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const question = args.trim();
	if (!question) {
		notify(
			ctx,
			"Uso: /btw <pregunta> — hacé una pregunta rápida y lateral sobre la conversación actual (no se agrega al historial).",
			"info",
		);
		return;
	}

	const model = ctx.model;
	if (!model) {
		notify(ctx, "No hay modelo seleccionado. Elegí uno con /model y volvé a intentar con /btw.", "error");
		return;
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		notify(ctx, `No hay credenciales utilizables para ${model.provider}/${model.id}: ${auth.error}`, "error");
		return;
	}

	// Build the one-shot request from the current branch (read-only) + the question.
	const context = buildBtwContext({ entries: ctx.sessionManager.getBranch(), convertToLlm, question });

	const options: SimpleStreamOptions = {
		maxTokens: BTW_MAX_TOKENS,
		signal: ctx.signal,
		apiKey: auth.apiKey,
		headers: auth.headers,
		env: auth.env,
	};
	// Reasoning only applies to reasoning-capable models; otherwise it is rejected/ignored.
	// pi.getThinkingLevel() and SimpleStreamOptions.reasoning use distinct (but compatible)
	// ThinkingLevel declarations, so narrow to the option's type.
	if (model.reasoning) options.reasoning = pi.getThinkingLevel() as SimpleStreamOptions["reasoning"];

	const showStatus = ctx.hasUI && typeof ctx.ui.setStatus === "function";
	if (showStatus) ctx.ui.setStatus(STATUS_KEY, "btw: thinking…");

	let response: AssistantMessage;
	try {
		response = await completeSimple(model, context, options);
	} catch (error) {
		notify(ctx, `btw falló: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	} finally {
		if (showStatus) ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	if (response.stopReason === "error") {
		notify(ctx, `btw falló: ${response.errorMessage ?? "el modelo devolvió un error"}`, "error");
		return;
	}
	if (response.stopReason === "aborted") {
		notify(ctx, "btw cancelado.", "info");
		return;
	}

	const answer = extractAnswerText(response);
	if (!answer) {
		notify(ctx, "btw: el modelo no devolvió respuesta.", "warning");
		return;
	}

	// Display WITHOUT persisting: overlay in the TUI, plain output otherwise.
	if (ctx.mode === "tui" && ctx.hasUI) {
		await openAnswerOverlay(ctx, question, answer);
	} else if (ctx.mode === "print") {
		console.log(answer);
	} else if (ctx.hasUI) {
		ctx.ui.notify(answer, "info");
	} else {
		console.log(answer);
	}
}

export default function btwExtension(pi: ExtensionAPI): void {
	pi.registerCommand("btw", {
		description:
			"Hacé una pregunta rápida y lateral sobre la conversación actual (sin tools, no se agrega al historial).",
		handler: async (args, ctx) => {
			await handleBtw(args, ctx, pi);
		},
	});
}
