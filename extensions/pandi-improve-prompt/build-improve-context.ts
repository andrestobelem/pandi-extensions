/**
 * Ayudantes puros y deterministas para el comando `/improve-prompt`.
 *
 * Igual que build-btw-context.ts de pandi-btw, este módulo no toca el LLM, la red ni
 * ninguna API de runtime de Pi: solo arma la solicitud de una pasada y lee la respuesta
 * del modelo, así que puede probarse de forma aislada, dejando index.ts como la capa fina
 * de orquestación (llamar al modelo, mostrar el resultado, enviar opcionalmente).
 *
 * Deliberadamente AUTÓNOMO (a diferencia de /btw): el borrador de prompt se juzga por su
 * propio texto, no anclado a la rama actual de conversación, así que una utilidad de
 * "mejorá este prompt" funciona igual haya o no historial previo.
 */

import type { AssistantMessage, Message, TextContent } from "@earendil-works/pi-ai";

/**
 * Prompt del sistema para la reescritura. Presenta al modelo como editor de prompts para
 * un agente de programación con IA: resolver ambigüedades, volver verificable el éxito,
 * conservar el idioma y la intención del usuario, mantenerse conciso y —crucialmente—
 * devolver SOLO el prompt reescrito para que el llamador pueda reutilizarlo tal cual (como
 * mensaje) sin parseo extra.
 */
const IMPROVE_PROMPT_SYSTEM_PROMPT_RULES = [
	"Reescribí BORRADORES DE PROMPT para un agente de programación con IA de modo que queden más claros y accionables.",
	"Resolvé ambigüedades, agregá criterios de éxito concretos y verificables cuando aporte valor, y mantené el idioma, la intención y el alcance originales — no inventes requisitos nuevos.",
	"Mantenelo conciso: un prompt más claro, no más largo.",
	"Devolvé SOLO el texto reescrito — sin preámbulo, sin explicación, sin comillas, sin fences de Markdown.",
] as const;

export const IMPROVE_PROMPT_SYSTEM_PROMPT = IMPROVE_PROMPT_SYSTEM_PROMPT_RULES.join(" ");

/** Solicitud lista para enviar: prompt de sistema + mensajes, y deliberadamente SIN herramientas. */
export interface ImproveContext {
	systemPrompt: string;
	messages: Message[];
}

/**
 * Arma la solicitud de reescritura de una pasada: el borrador como único mensaje de
 * usuario, más el prompt del sistema de improve-prompt. No se incluyen herramientas,
 * así que el modelo solo puede responder en texto. Pura y determinista salvo por la marca
 * temporal del mensaje.
 */
export function buildImproveContext(draft: string): ImproveContext {
	return {
		systemPrompt: IMPROVE_PROMPT_SYSTEM_PROMPT,
		messages: [{ role: "user", content: draft, timestamp: Date.now() }],
	};
}

/**
 * Une los bloques de texto de un mensaje de asistente en una sola cadena, ignorando los
 * bloques no textuales (thinking, tool calls). Hace trim; devuelve "" cuando no hay texto.
 */
export function extractImprovedText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n\n")
		.trim();
}
