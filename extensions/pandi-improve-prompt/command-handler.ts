import type { AssistantMessage, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { openAnswerOverlay } from "./answer-overlay.js";
import { buildImproveContext, extractImprovedText } from "./build-improve-context.js";
import { notify } from "./notify.js";

const IMPROVE_PROMPT_MAX_TOKENS = 2048;
const STATUS_KEY = "improve-prompt";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatImprovePromptFailure(error: unknown): string {
	return `improve-prompt falló: ${errorMessage(error)}`;
}

function setImprovePromptStatus(ctx: ExtensionCommandContext, value: string | undefined): boolean {
	if (!ctx.hasUI || typeof ctx.ui.setStatus !== "function") return false;
	ctx.ui.setStatus(STATUS_KEY, value);
	return true;
}

/** Envía el prompt mejorado como el siguiente turno de usuario, idle vs. mid-stream (como el wake de /plan). */
function sendImprovedPrompt(pi: ExtensionAPI, ctx: ExtensionCommandContext, improved: string): void {
	if (ctx.isIdle()) pi.sendUserMessage(improved);
	else pi.sendUserMessage(improved, { deliverAs: "followUp" });
}

export async function handleImprovePromptCommand(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<void> {
	const draft = args.trim();
	if (!draft) {
		notify(ctx, "Uso: /improve-prompt <borrador> — lo reescribe y te ofrece enviarlo.", "info");
		return;
	}

	const model = ctx.model;
	if (!model) {
		notify(ctx, "No hay modelo seleccionado. Elegí uno con /model y reintentá /improve-prompt.", "error");
		return;
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		notify(ctx, `No hay credenciales utilizables para ${model.provider}/${model.id}: ${auth.error}`, "error");
		return;
	}

	const context = buildImproveContext(draft);

	const options: SimpleStreamOptions = {
		maxTokens: IMPROVE_PROMPT_MAX_TOKENS,
		signal: ctx.signal,
		apiKey: auth.apiKey,
		headers: auth.headers,
		env: auth.env,
	};
	if (model.reasoning) options.reasoning = pi.getThinkingLevel() as SimpleStreamOptions["reasoning"];

	const showStatus = setImprovePromptStatus(ctx, "improve-prompt: pensando…");

	let response: AssistantMessage;
	try {
		response = await completeSimple(model, context, options);
	} catch (error) {
		notify(ctx, formatImprovePromptFailure(error), "error");
		return;
	} finally {
		if (showStatus) setImprovePromptStatus(ctx, undefined);
	}

	if (response.stopReason === "error") {
		notify(ctx, `improve-prompt falló: ${response.errorMessage ?? "el modelo devolvió un error"}`, "error");
		return;
	}
	if (response.stopReason === "aborted") {
		notify(ctx, "improve-prompt cancelado.", "info");
		return;
	}

	const improved = extractImprovedText(response);
	if (!improved) {
		notify(ctx, "improve-prompt: el modelo no devolvió ninguna reescritura.", "warning");
		return;
	}

	if (ctx.mode === "print" || !ctx.hasUI) {
		console.log(improved);
		return;
	}

	const body = `**Original**\n\n${draft}\n\n---\n\n**Mejorado**\n\n${improved}`;
	if (ctx.mode === "tui") {
		await openAnswerOverlay(ctx, "revisá y confirmá abajo", body);
	} else {
		ctx.ui.notify(body, "info");
	}

	const shouldSend = await ctx.ui.confirm("¿Enviar el prompt mejorado como tu próximo mensaje?", improved);
	if (!shouldSend) {
		notify(ctx, "No enviado — el prompt mejorado quedó solo en pantalla.", "info");
		return;
	}
	sendImprovedPrompt(pi, ctx, improved);
}
