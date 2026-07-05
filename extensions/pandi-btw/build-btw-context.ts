/**
 * Ayudantes puros y deterministas para el comando `/btw`.
 *
 * Como derive-name.ts de pandi-rename, este módulo nunca toca el LLM, la red ni ninguna API
 * runtime de Pi: solo transforma estructuras de datos. Todas las *decisiones* que toma
 * `/btw` sobre qué enviarle al modelo y cómo leer su respuesta viven acá para poder
 * probarlas con tests unitarios en aislamiento, dejando a index.ts como una capa delgada
 * de orquestación (leer la sesión, llamar al modelo, renderizar el overlay).
 *
 * `/btw` (igual que en Claude Code) hace una pregunta lateral rápida que usa la
 * conversación actual como contexto, devuelve una única respuesta sin tools y nunca se
 * persiste en el historial de la conversación. Este archivo arma ese request one-shot y
 * extrae el texto de la respuesta; deliberadamente no sabe nada sobre persistencia
 * (quien llama simplemente nunca escribe nada de vuelta).
 *
 * Los imports solo de tipos del SDK se borran en tiempo de build, así que esto queda libre del SDK
 * en ejecución y se bundlea para tests sin aliases.
 */

import type { AssistantMessage, Message, TextContent } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

/** La forma de mensaje de conversación que lleva una entrada de sesión `message`. */
type AgentMessage = SessionMessageEntry["message"];

/**
 * System prompt para la pregunta lateral. Enmarca al modelo para responder una pregunta
 * rápida SOBRE la conversación hasta ahora: concisa, apoyada en el contexto existente y
 * explícitamente no como un pedido de tomar acciones o usar tools (el request igual no
 * lleva tools).
 */
export const BTW_SYSTEM_PROMPT =
	"Estás respondiendo una pregunta rápida y lateral sobre la conversación mostrada arriba. " +
	"Respondé de forma concisa y directa, basándote ÚNICAMENTE en ese contexto existente — por ejemplo " +
	'"¿qué decidimos?" o "¿qué archivo era ese?". No propongas tomar nuevas acciones, ' +
	"ejecutar comandos, ni usar tools; solo respondé la pregunta con lo que ya se sabe. " +
	"Si la conversación no contiene la respuesta, decilo brevemente.";

export interface BtwContextInput {
	/** La rama actual de la conversación (de sessionManager.getBranch()). */
	entries: readonly SessionEntry[];
	/** El convertToLlm del SDK, inyectado para que este módulo siga libre del SDK y sea testeable. */
	convertToLlm: (messages: AgentMessage[]) => Message[];
	/** La pregunta lateral del usuario (ya recortada y garantizada como no vacía). */
	question: string;
}

/** Un request one-shot listo para enviar: un prompt de sistema + mensajes, y deliberadamente sin tools. */
export interface BtwContext {
	systemPrompt: string;
	messages: Message[];
}

/**
 * Extraé los mensajes de conversación de una rama de sesión: conservá solo las entradas
 * `message` (descartando resúmenes de compaction, marcadores de cambio de modelo,
 * entradas custom, etc.) y devolvé su AgentMessage subyacente en orden. El texto tipeado
 * del comando `/btw …` nunca es una entrada de sesión, así que acá naturalmente no
 * aparece: eso es lo que mantiene la pregunta lateral fuera del historial.
 */
export function extractMessages(entries: readonly SessionEntry[]): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (const entry of entries) {
		if (entry.type === "message") messages.push(entry.message);
	}
	return messages;
}

/**
 * Armá el request one-shot de la pregunta lateral: la conversación existente (convertida
 * a mensajes LLM) seguida por la pregunta como mensaje final del usuario, más el system
 * prompt de btw. No se incluyen tools, así que el modelo solo puede responder en texto.
 * Puro y determinista salvo por el timestamp del mensaje agregado.
 */
export function buildBtwContext(input: BtwContextInput): BtwContext {
	const agentMessages = extractMessages(input.entries);
	const messages = input.convertToLlm(agentMessages);
	messages.push({ role: "user", content: input.question, timestamp: Date.now() });
	return { systemPrompt: BTW_SYSTEM_PROMPT, messages };
}

/**
 * Uní los bloques de texto de un mensaje del assistant en un solo string, ignorando los
 * bloques no textuales (thinking, tool calls). Hace trim; devuelve "" cuando no hay
 * contenido de texto.
 */
export function extractAnswerText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n\n")
		.trim();
}
