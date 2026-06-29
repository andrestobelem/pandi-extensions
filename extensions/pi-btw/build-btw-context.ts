/**
 * Pure, deterministic helpers for the `/btw` command.
 *
 * Like pi-rename's derive-name.ts, this module never touches the LLM, the network, or
 * any Pi runtime API: it only transforms data structures. All the *decisions* `/btw`
 * makes about what to send the model and how to read its answer live here so they can be
 * unit-tested in isolation, leaving index.ts as the thin orchestration layer (read the
 * session, call the model, render the overlay).
 *
 * `/btw` (mirroring Claude Code) asks a quick SIDE question that uses the CURRENT
 * conversation as context, returns a single answer with NO tools, and is NEVER persisted
 * to the conversation history. This file builds that one-shot request and extracts the
 * answer text; it deliberately knows nothing about persistence (the caller simply never
 * writes anything back).
 *
 * Type-only imports from the SDK are erased at build time, so this stays runtime-SDK-free
 * and bundles for tests with no aliases.
 */

import type { AssistantMessage, Message, TextContent } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

/** The conversation message shape carried by a `message` session entry. */
type AgentMessage = SessionMessageEntry["message"];

/**
 * System prompt for the side question. It frames the model as answering a quick question
 * ABOUT the conversation so far — concise, grounded in existing context, and explicitly
 * not a request to take actions or use tools (the request carries no tools anyway).
 */
export const BTW_SYSTEM_PROMPT =
	"You are answering a quick side question about the ongoing conversation shown above. " +
	"Answer concisely and directly, grounded ONLY in that existing context — for example " +
	'"what did we decide?" or "what file was that?". Do not propose taking new actions, ' +
	"running commands, or using tools; just answer the question from what is already known. " +
	"If the conversation does not contain the answer, say so briefly.";

export interface BtwContextInput {
	/** The current conversation branch (from sessionManager.getBranch()). */
	entries: readonly SessionEntry[];
	/** The SDK's convertToLlm, injected so this module stays SDK-free and testable. */
	convertToLlm: (messages: AgentMessage[]) => Message[];
	/** The user's side question (already trimmed and known non-empty). */
	question: string;
}

/** A ready-to-send one-shot request: a system prompt + messages, and deliberately NO tools. */
export interface BtwContext {
	systemPrompt: string;
	messages: Message[];
}

/**
 * Extract the conversation messages from a session branch: keep only `message` entries
 * (dropping compaction summaries, model-change markers, custom entries, etc.) and return
 * their underlying AgentMessage in order. The typed `/btw …` command text is never a
 * session entry, so it is naturally absent here — which is what keeps the side question
 * out of history.
 */
export function extractMessages(entries: readonly SessionEntry[]): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (const entry of entries) {
		if (entry.type === "message") messages.push(entry.message);
	}
	return messages;
}

/**
 * Build the one-shot side-question request: the existing conversation (converted to LLM
 * messages) followed by the question as a final user message, plus the btw system prompt.
 * No tools are included, so the model can only answer in text. Pure and deterministic
 * apart from the appended message timestamp.
 */
export function buildBtwContext(input: BtwContextInput): BtwContext {
	const agentMessages = extractMessages(input.entries);
	const messages = input.convertToLlm(agentMessages);
	messages.push({ role: "user", content: input.question, timestamp: Date.now() });
	return { systemPrompt: BTW_SYSTEM_PROMPT, messages };
}

/**
 * Join the text blocks of an assistant message into a single string, ignoring non-text
 * blocks (thinking, tool calls). Trimmed; returns "" when there is no text content.
 */
export function extractAnswerText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n\n")
		.trim();
}
