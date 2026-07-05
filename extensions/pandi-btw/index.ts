/**
 * Comando `/btw` estilo Claude para Pi.
 *
 * El `/btw <question>` de Claude Code hace una pregunta lateral rápida que usa la
 * conversación actual como contexto, devuelve una única respuesta sin acceso a tools y
 * nunca se agrega al historial de la conversación: aparece en un overlay cerrable. Está
 * pensado para consultas del tipo "¿qué decidimos?" / "¿qué archivo era ese?" sobre
 * contexto que el modelo ya tiene, no para tareas que necesiten nuevas lecturas de
 * archivos, comandos o web searches.
 *
 * Esta extensión replica eso en Pi:
 *
 *   /btw qué decidimos sobre auth?        -> llamada one-shot al modelo sobre la rama actual,
 *                                            respuesta mostrada en un overlay desplazable,
 *                                            nada se escribe de vuelta en la sesión.
 *
 * Cómo queda fuera del historial: un command handler corre inmediatamente cuando el
 * usuario envía `/btw …` (el texto tipeado no se agrega a la sesión), solo leemos la rama
 * con sessionManager.getBranch(), y mostramos la respuesta con ctx.ui
 * (overlay/notify/console): nunca llamamos a pi.sendMessage, pi.appendEntry,
 * pi.setSessionName ni a ninguna escritura de sesión.
 *
 * El request se arma con completeSimple() y no lleva tools, así que el modelo solo puede
 * responder en texto. La lógica pura de request/respuesta vive en ./build-btw-context;
 * el overlay vive en ./answer-overlay; este archivo solo orquesta.
 */

import type { AssistantMessage, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { openAnswerOverlay } from "./answer-overlay.js";
import { buildBtwContext, extractAnswerText } from "./build-btw-context.js";

/** Limitá la respuesta lateral: debe ser una respuesta rápida, no una generación larga. */
const BTW_MAX_TOKENS = 2048;

const STATUS_KEY = "btw";

/** Notificá al usuario, degradando con gracia fuera de la TUI (refleja el ayudante de pi-mdview). */
function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	// La superficie overlay/notify solo existe en una sesión interactiva (TUI/RPC). En los
	// modos print y json (headless, hasUI=false) no hay UI, así que hacé fallback a la
	// consola: de lo contrario, los errores/advertencias se descartan en silencio en modo
	// json (y una falla queda indistinguible de un cuelgue).
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

	// Armá el request one-shot desde la rama actual (solo lectura) + la pregunta.
	const context = buildBtwContext({ entries: ctx.sessionManager.getBranch(), convertToLlm, question });

	const options: SimpleStreamOptions = {
		maxTokens: BTW_MAX_TOKENS,
		signal: ctx.signal,
		apiKey: auth.apiKey,
		headers: auth.headers,
		env: auth.env,
	};
	// Reasoning solo aplica a modelos con reasoning; de lo contrario se rechaza/ignora.
	// pi.getThinkingLevel() y SimpleStreamOptions.reasoning usan declaraciones
	// ThinkingLevel distintas (pero compatibles), así que estrechá al tipo de la opción.
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

	// Mostrá SIN persistir: overlay en la TUI, salida simple en otro caso.
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
