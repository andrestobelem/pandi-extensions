/**
 * Resumen del nombre de sesión con LLM para `/rename` (sin argumento).
 *
 * La ruta determinística en ./derive-name convierte en slug el mensaje de usuario más reciente tal cual.
 * En cambio, este módulo arma un prompt a partir de la parte MÁS RECIENTE de la conversación y
 * le pide a un LLM (vía un runner inyectado) que la resuma en un título corto, que luego se
 * convierte en slug. El runner se inyecta para que este módulo nunca toque un proceso ni la red
 * por sí mismo — el subproceso real vive en ./spawn-summary, y los tests pasan un stub. Ante cualquier
 * falla (offline, sin API key, timeout, salida vacía/basura o sin historial) vuelve al resultado
 * determinístico de ./derive-name, así que `/rename` siempre produce un nombre.
 *
 * Es puro salvo por llamar al runner inyectado, así que el armado del prompt, el parseo de salida
 * y la lógica de respaldo son todos testeables sin un LLM.
 */

import { DEFAULT_SESSION_NAME, type DeriveOptions, deriveSessionName, slugify } from "./derive-name.js";
import { textContentFromMessageContent } from "./message-content.js";

/** Cuántos mensajes finales cuentan como "la parte más reciente" de la conversación. */
export const MAX_SUMMARY_MESSAGES = 8;
/** Tope duro del texto de conversación enviado al modelo (se conserva la cola más reciente). */
export const MAX_SUMMARY_CHARS = 4000;

/** Ejecuta el prompt de resumen a través de un LLM y resuelve su texto crudo (o rechaza). */
export type SummaryRunner = (prompt: string) => Promise<string>;

export interface SummarizeOptions extends DeriveOptions {
	maxMessages?: number;
	maxChars?: number;
}

export interface SummarizeArgs extends SummarizeOptions {
	entries: unknown;
	runSummary: SummaryRunner;
}

export interface SummarizeResult {
	/** El slug a aplicar. */
	name: string;
	/** True cuando se usó el respaldo determinístico en vez de un resumen del LLM. */
	fellBack: boolean;
}

/** Extrae `{role, text}` de una entrada de mensaje `user`/`assistant` (ignora bloques de imagen). */
function extractRoleText(entry: unknown): { role: string; text: string } | undefined {
	const message = (entry as { message?: { role?: string; content?: unknown } } | null)?.message;
	const role = message?.role;
	if (role !== "user" && role !== "assistant") return undefined;
	const text = textContentFromMessageContent(message?.content).trim();
	return text ? { role, text } : undefined;
}

/** Los últimos `maxMessages` mensajes no vacíos de user/assistant, en orden cronológico. */
function recentMessages(entries: unknown, maxMessages: number): { role: string; text: string }[] {
	const list = Array.isArray(entries) ? entries : [];
	const out: { role: string; text: string }[] = [];
	for (let i = list.length - 1; i >= 0 && out.length < maxMessages; i--) {
		const msg = extractRoleText(list[i]);
		if (msg) out.push(msg);
	}
	return out.reverse();
}

function formatRecentConversation(messages: { role: string; text: string }[], maxChars: number): string {
	let convo = messages.map((m) => `${m.role}: ${m.text}`).join("\n");
	// Conservá la cola más reciente cuando supera el tope.
	if (convo.length > maxChars) convo = convo.slice(convo.length - maxChars);
	return convo;
}

/**
 * Arma el prompt de resumen a partir de la parte más reciente de la conversación. Devuelve
 * "" cuando no hay nada para resumir (así quien llama puede saltear el LLM por completo).
 */
export function buildSummaryPrompt(entries: unknown, opts: SummarizeOptions = {}): string {
	const maxMessages = opts.maxMessages ?? MAX_SUMMARY_MESSAGES;
	const maxChars = opts.maxChars ?? MAX_SUMMARY_CHARS;
	const messages = recentMessages(entries, maxMessages);
	if (messages.length === 0) return "";
	const convo = formatRecentConversation(messages, maxChars);
	return [
		"Estás nombrando una sesión de trabajo en base a su actividad MÁS RECIENTE.",
		"Leé la conversación reciente de abajo y responde con un título CORTO de 2 a 4 palabras",
		"que describa en qué se está trabajando ahora. Responde SOLO con el título — sin comillas,",
		"sin puntuación, sin preámbulo, sin explicación.",
		"",
		"Conversación reciente:",
		convo,
	].join("\n");
}

/** Convierte la salida cruda del modelo en un slug: toma la primera línea no vacía y luego aplica slugify (que ya
 * quita comillas, markdown y puntuación). Devuelve "" cuando no queda nada convertible a slug. */
export function slugFromSummaryOutput(raw: string, opts: SummarizeOptions = {}): string {
	const firstLine =
		String(raw ?? "")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean) ?? "";
	return slugify(firstLine, opts);
}

/**
 * Resume la conversación reciente en un nombre de sesión slug, con respaldo al resultado
 * determinístico de ./derive-name ante cualquier falla (sin historial, runner lanza o expira,
 * o salida vacía/basura). Nunca lanza.
 */
export async function summarizeSessionName(args: SummarizeArgs): Promise<SummarizeResult> {
	const { entries, runSummary, ...opts } = args;
	const fallbackName = deriveSessionName(entries, opts) || (opts.defaultName ?? DEFAULT_SESSION_NAME);
	const prompt = buildSummaryPrompt(entries, opts);
	if (!prompt) return { name: fallbackName, fellBack: true };
	try {
		const raw = await runSummary(prompt);
		const slug = slugFromSummaryOutput(raw, opts);
		if (slug) return { name: slug, fellBack: false };
	} catch {
		// seguí hacia el respaldo determinístico
	}
	return { name: fallbackName, fellBack: true };
}
