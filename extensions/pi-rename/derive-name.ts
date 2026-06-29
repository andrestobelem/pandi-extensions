/**
 * Pure, deterministic helpers for the `/rename` command.
 *
 * These never touch the LLM, the network, or any Pi API: given the same input they
 * always return the same name. The extension's index.ts is the only orchestration
 * layer (reads the session, talks to the UI); all naming logic lives here so it can
 * be unit-tested in isolation.
 */

/** Default name used when nothing usable can be derived from the conversation. */
export const DEFAULT_SESSION_NAME = "session";

/** Baseline limits for an auto-derived name. Tunable; pinned by the test suite. */
export const MAX_NAME_CHARS = 60;
export const MAX_NAME_WORDS = 8;

export interface DeriveOptions {
	maxChars?: number;
	maxWords?: number;
	defaultName?: string;
}

/**
 * Normalize a user-supplied or derived name: trim, drop a single layer of wrapping
 * matching quotes, and collapse all internal whitespace (newlines/tabs included) to
 * single spaces. Legitimate internal spaces are preserved.
 */
export function normalizeName(raw: string): string {
	let value = (raw ?? "").trim();
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			value = value.slice(1, -1).trim();
		}
	}
	return value.replace(/\s+/g, " ").trim();
}

/** Extract the joined text content of a `user` message entry (ignores image blocks). */
function extractUserText(entry: unknown): string {
	const message = (entry as { message?: { role?: string; content?: unknown } } | null)?.message;
	if (message?.role !== "user") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(block): block is { type: "text"; text: string } =>
					!!block &&
					(block as { type?: string }).type === "text" &&
					typeof (block as { text?: unknown }).text === "string",
			)
			.map((block) => block.text)
			.join(" ");
	}
	return "";
}

/** Strip leading slash-command tokens and simple markdown markers, collapse whitespace. */
function stripChrome(text: string): string {
	let value = text.replace(/\s+/g, " ").trim();
	// Drop a leading slash-command token, e.g. "/rename foo" -> "foo".
	value = value.replace(/^\/[a-zA-Z][\w-]*\s*/, "");
	// Strip simple markdown emphasis/heading/quote/code markers.
	value = value
		.replace(/[`*_#>]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return value;
}

/** Truncate to at most maxWords words and maxChars chars without splitting a word. */
function truncateWords(text: string, maxChars: number, maxWords: number): string {
	const words = text.split(" ").filter(Boolean).slice(0, Math.max(0, maxWords));
	let out = "";
	for (const word of words) {
		const candidate = out ? `${out} ${word}` : word;
		if (candidate.length > maxChars) break;
		out = candidate;
	}
	// A single first word longer than maxChars: hard-truncate it so we still return something.
	if (!out && words.length > 0) out = words[0].slice(0, Math.max(0, maxChars));
	return out;
}

/**
 * Derive a concise session name from the conversation history. Walks entries in order,
 * uses the first non-empty `user` message, cleans it up, and truncates. Returns the
 * default name when no usable text exists.
 */
export function deriveSessionName(entries: unknown, opts: DeriveOptions = {}): string {
	const maxChars = opts.maxChars ?? MAX_NAME_CHARS;
	const maxWords = opts.maxWords ?? MAX_NAME_WORDS;
	const fallback = opts.defaultName ?? DEFAULT_SESSION_NAME;
	const list = Array.isArray(entries) ? entries : [];
	for (const entry of list) {
		const raw = extractUserText(entry);
		if (!raw) continue;
		const name = normalizeName(truncateWords(stripChrome(raw), maxChars, maxWords));
		if (name) return name;
	}
	return fallback;
}
