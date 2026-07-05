/**
 * LLM-backed session-name summarization for `/rename` (no argument).
 *
 * The deterministic path in ./derive-name slugs the most recent user message verbatim.
 * This module instead builds a prompt from the MOST RECENT part of the conversation and
 * asks an LLM (via an injected runner) to summarize it into a short title, which is then
 * slugified. The runner is injected so this module never touches a process or the network
 * itself — the real subprocess lives in ./spawn-summary, and tests pass a stub. On any
 * failure (offline, no API key, timeout, empty/garbage output, or no history) it falls
 * back to the deterministic ./derive-name result, so `/rename` always produces a name.
 *
 * Pure except for calling the injected runner, so the prompt-building, output-parsing,
 * and fallback logic are all unit-testable without an LLM.
 */

import { DEFAULT_SESSION_NAME, type DeriveOptions, deriveSessionName, slugify } from "./derive-name.js";

/** How many trailing messages count as "the most recent part" of the conversation. */
export const MAX_SUMMARY_MESSAGES = 8;
/** Hard cap on the conversation text fed to the model (keep the most recent tail). */
export const MAX_SUMMARY_CHARS = 4000;

/** Runs the summary prompt through an LLM and resolves its raw text (or rejects). */
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
	/** The slug to apply. */
	name: string;
	/** True when the deterministic fallback was used instead of an LLM summary. */
	fellBack: boolean;
}

/** Extract `{role, text}` from a `user`/`assistant` message entry (ignores image blocks). */
function extractRoleText(entry: unknown): { role: string; text: string } | undefined {
	const message = (entry as { message?: { role?: string; content?: unknown } } | null)?.message;
	const role = message?.role;
	if (role !== "user" && role !== "assistant") return undefined;
	const content = message?.content;
	let text = "";
	if (typeof content === "string") {
		text = content;
	} else if (Array.isArray(content)) {
		text = content
			.filter(
				(block): block is { type: "text"; text: string } =>
					!!block &&
					(block as { type?: string }).type === "text" &&
					typeof (block as { text?: unknown }).text === "string",
			)
			.map((block) => block.text)
			.join(" ");
	}
	text = text.trim();
	return text ? { role, text } : undefined;
}

/** The last `maxMessages` non-empty user/assistant messages, in chronological order. */
function recentMessages(entries: unknown, maxMessages: number): { role: string; text: string }[] {
	const list = Array.isArray(entries) ? entries : [];
	const out: { role: string; text: string }[] = [];
	for (let i = list.length - 1; i >= 0 && out.length < maxMessages; i--) {
		const msg = extractRoleText(list[i]);
		if (msg) out.push(msg);
	}
	return out.reverse();
}

/**
 * Build the summarization prompt from the most recent part of the conversation. Returns
 * "" when there is nothing to summarize (so the caller can skip the LLM entirely).
 */
export function buildSummaryPrompt(entries: unknown, opts: SummarizeOptions = {}): string {
	const maxMessages = opts.maxMessages ?? MAX_SUMMARY_MESSAGES;
	const maxChars = opts.maxChars ?? MAX_SUMMARY_CHARS;
	const messages = recentMessages(entries, maxMessages);
	if (messages.length === 0) return "";
	let convo = messages.map((m) => `${m.role}: ${m.text}`).join("\n");
	// Keep the most recent tail when over the cap.
	if (convo.length > maxChars) convo = convo.slice(convo.length - maxChars);
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

/** Turn raw model output into a slug: first non-empty line, then slugify (which already
 * strips quotes, markdown, and punctuation). Returns "" when nothing slug-able remains. */
export function slugFromSummaryOutput(raw: string, opts: SummarizeOptions = {}): string {
	const firstLine =
		String(raw ?? "")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean) ?? "";
	return slugify(firstLine, opts);
}

/**
 * Summarize the recent conversation into a slug session name, falling back to the
 * deterministic ./derive-name result on any failure (no history, runner throws/times out,
 * or empty/garbage output). Never throws.
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
		// fall through to the deterministic fallback
	}
	return { name: fallbackName, fellBack: true };
}
