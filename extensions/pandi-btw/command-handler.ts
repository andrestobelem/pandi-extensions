import type { AssistantMessage, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { openAnswerOverlay } from "./answer-overlay.js";
import { buildBtwContext, extractAnswerText } from "./build-btw-context.js";
import { notify } from "./notify.js";

const BTW_MAX_TOKENS = 2048;
const STATUS_KEY = "btw";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatBtwFailure(error: unknown): string {
	return `btw falló: ${errorMessage(error)}`;
}

function setBtwStatus(ctx: ExtensionCommandContext, value: string | undefined): boolean {
	if (!ctx.hasUI || typeof ctx.ui.setStatus !== "function") return false;
	ctx.ui.setStatus(STATUS_KEY, value);
	return true;
}

async function presentBtwAnswer(ctx: ExtensionCommandContext, question: string, answer: string): Promise<void> {
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

export async function handleBtwCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
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

	const context = buildBtwContext({ entries: ctx.sessionManager.getBranch(), convertToLlm, question });

	const options: SimpleStreamOptions = {
		maxTokens: BTW_MAX_TOKENS,
		signal: ctx.signal,
		apiKey: auth.apiKey,
		headers: auth.headers,
		env: auth.env,
	};
	if (model.reasoning) options.reasoning = pi.getThinkingLevel() as SimpleStreamOptions["reasoning"];

	const showStatus = setBtwStatus(ctx, "btw: pensando…");

	let response: AssistantMessage;
	try {
		response = await completeSimple(model, context, options);
	} catch (error) {
		notify(ctx, formatBtwFailure(error), "error");
		return;
	} finally {
		if (showStatus) setBtwStatus(ctx, undefined);
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

	await presentBtwAnswer(ctx, question, answer);
}
