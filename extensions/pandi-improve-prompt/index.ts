/**
 * `/improve-prompt` — reescribe un borrador de prompt torpe en uno más claro y
 * accionable antes de enviarlo.
 *
 *   /improve-prompt fix the bug in the parser
 *     -> una sola llamada al modelo (sin herramientas) reescribe el borrador:
 *        resuelve ambigüedades, agrega criterios de éxito verificables cuando
 *        aporta valor y conserva tu idioma e intención.
 *     -> se muestra para revisión (overlay en la TUI, salida simple en otros
 *        modos).
 *     -> pregunta (ctx.ui.confirm) si querés ENVIARLO como tu próximo mensaje.
 *        Confirmar -> pi.sendUserMessage() lo inyecta como un turno de usuario
 *        real (como el wake de aprobación de /plan). Rechazar -> no se envía
 *        nada; la reescritura solo quedó en pantalla.
 *
 * Copia la forma de pandi-btw (llamada completeSimple de una pasada, sin
 * herramientas, visualización tipo overlay-o-print), pero AGREGA el paso de
 * confirmación y envío, porque — a diferencia de una pregunta lateral — el
 * objetivo de un prompt mejorado es usarlo de verdad.
 *
 * En print/json (sin UI interactiva): la reescritura se imprime y no se envía
 * nada — una ejecución de una sola pasada no puede pedir confirmación, así que
 * enviarla sería un efecto secundario sin revisar.
 */

import type { AssistantMessage, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { openAnswerOverlay } from "./answer-overlay.js";
import { buildImproveContext, extractImprovedText } from "./build-improve-context.js";

/** La reescritura debe ser un prompt más claro, no un ensayo largo. */
const IMPROVE_PROMPT_MAX_TOKENS = 2048;

const STATUS_KEY = "improve-prompt";

/** Notifica al usuario y degrada con gracia fuera de la TUI (como las extensiones hermanas). */
function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.mode !== "print" && ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	if (type === "info") console.log(message);
	else console.error(message);
}

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
function send(pi: ExtensionAPI, ctx: ExtensionCommandContext, improved: string): void {
	if (ctx.isIdle()) pi.sendUserMessage(improved);
	else pi.sendUserMessage(improved, { deliverAs: "followUp" });
}

async function handleImprovePrompt(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
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
	// La razón solo aplica a modelos que la soportan; si no, se rechaza o se ignora.
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

	// Print/json: mostramos la reescritura y paramos.
	// Enviarla sin revisión sería un efecto secundario silencioso.
	if (ctx.mode === "print" || !ctx.hasUI) {
		console.log(improved);
		return;
	}

	const body = `**Original**\n\n${draft}\n\n---\n\n**Mejorado**\n\n${improved}`;
	if (ctx.mode === "tui") {
		await openAnswerOverlay(ctx, "revisá y confirmá abajo", body);
	} else {
		// rpc: tiene UI pero no el overlay personalizado de terminal de custom().
		ctx.ui.notify(body, "info");
	}

	const shouldSend = await ctx.ui.confirm("¿Enviar el prompt mejorado como tu próximo mensaje?", improved);
	if (!shouldSend) {
		notify(ctx, "No enviado — el prompt mejorado quedó solo en pantalla.", "info");
		return;
	}
	send(pi, ctx, improved);
}

export default function improvePromptExtension(pi: ExtensionAPI): void {
	pi.registerCommand("improve-prompt", {
		description: "Reescribe un borrador de prompt y te ofrece enviarlo como tu próximo mensaje.",
		handler: async (args, ctx) => {
			await handleImprovePrompt(args, ctx, pi);
		},
	});
}
