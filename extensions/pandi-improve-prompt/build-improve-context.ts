/**
 * Pure, deterministic helpers for the `/improve-prompt` command.
 *
 * Like pandi-btw's build-btw-context.ts, this module never touches the LLM, the network, or
 * any Pi runtime API: it only builds the one-shot request and reads the model's answer, so
 * it can be unit-tested in isolation, leaving index.ts as the thin orchestration layer
 * (call the model, show the result, optionally send it).
 *
 * Deliberately STANDALONE (unlike /btw): the draft prompt is judged on its own text, not
 * grounded in the current conversation branch, so a "mejora este prompt" utility works the
 * same whether or not there is prior chat history.
 */

import type { AssistantMessage, Message, TextContent } from "@earendil-works/pi-ai";

/**
 * System prompt for the rewrite. Frames the model as a prompt editor for an AI coding
 * agent: resolve ambiguity, make success verifiable, keep the user's language and intent,
 * stay concise, and — critically — output ONLY the rewritten prompt so the caller can
 * reuse it verbatim (as a message) with no extra parsing.
 */
export const IMPROVE_PROMPT_SYSTEM_PROMPT =
	"You rewrite DRAFT PROMPTS for an AI coding agent so they are clearer and more actionable. " +
	"Resolve ambiguity, add concrete/verifiable success criteria when it helps, and keep the " +
	"original language, intent, and scope — do not invent new requirements. Keep it concise: " +
	"a clearer prompt, not a longer one. " +
	"Output ONLY the rewritten prompt text — no preamble, no explanation, no quotes, no markdown fences.";

/** A ready-to-send one-shot request: a system prompt + messages, and deliberately NO tools. */
export interface ImproveContext {
	systemPrompt: string;
	messages: Message[];
}

/**
 * Build the one-shot rewrite request: the draft as the only user message, plus the
 * improve-prompt system prompt. No tools are included, so the model can only answer in
 * text. Pure and deterministic apart from the message timestamp.
 */
export function buildImproveContext(draft: string): ImproveContext {
	return {
		systemPrompt: IMPROVE_PROMPT_SYSTEM_PROMPT,
		messages: [{ role: "user", content: draft, timestamp: Date.now() }],
	};
}

/**
 * Join the text blocks of an assistant message into a single string, ignoring non-text
 * blocks (thinking, tool calls). Trimmed; returns "" when there is no text content.
 */
export function extractImprovedText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n\n")
		.trim();
}
