/**
 * Pure, deterministic helpers for the `/rename` command.
 *
 * These never touch the LLM, the network, or any Pi API: given the same input they
 * always return the same name. The extension's index.ts is the only orchestration
 * layer (reads the session, talks to the UI); all naming logic lives here so it can
 * be unit-tested in isolation.
 *
 * Every name produced here is a slug: lowercase, ASCII alphanumerics separated by
 * single hyphens, no leading/trailing/repeated hyphens.
 */

/** Default name used when nothing usable can be derived from the conversation. */
export const DEFAULT_SESSION_NAME = "session";

/** Baseline limits for a slug. Tunable; pinned by the test suite. */
export const MAX_NAME_CHARS = 60;
export const MAX_NAME_WORDS = 8;

export interface SlugOptions {
	maxChars?: number;
	maxWords?: number;
}

export interface DeriveOptions extends SlugOptions {
	defaultName?: string;
}

/**
 * Convert arbitrary text into a slug: strip diacritics, lowercase, split on every run
 * of non-alphanumeric characters, and join the words with hyphens. Truncates to at most
 * maxWords words and maxChars chars without splitting a word (a single oversized word is
 * hard-truncated so the result is never empty when there was content). Returns "" when
 * there is nothing slug-able.
 */
export function slugify(raw: string, opts: SlugOptions = {}): string {
	const maxChars = opts.maxChars ?? MAX_NAME_CHARS;
	const maxWords = opts.maxWords ?? MAX_NAME_WORDS;
	const base = (raw ?? "")
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "") // drop combining diacritical marks
		.toLowerCase();
	let words = base.split(/[^a-z0-9]+/).filter(Boolean);
	if (maxWords > 0) words = words.slice(0, maxWords);
	let slug = "";
	for (const word of words) {
		const candidate = slug ? `${slug}-${word}` : word;
		if (candidate.length > maxChars) break;
		slug = candidate;
	}
	// A single first word longer than maxChars: hard-truncate so we still return a slug.
	if (!slug && words.length > 0) slug = words[0].slice(0, Math.max(0, maxChars));
	return slug;
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

/**
 * Derive a slug session name from the conversation history. Walks entries in order,
 * uses the first `user` message that yields a non-empty slug (a leading slash-command
 * token is dropped first), and returns the default name when none does.
 */
export function deriveSessionName(entries: unknown, opts: DeriveOptions = {}): string {
	const fallback = opts.defaultName ?? DEFAULT_SESSION_NAME;
	const list = Array.isArray(entries) ? entries : [];
	for (const entry of list) {
		const raw = extractUserText(entry);
		if (!raw) continue;
		// Drop a leading slash-command token, e.g. "/explain the cache" -> "the cache".
		const cleaned = raw.replace(/^\s*\/[a-zA-Z][\w-]*\s*/, "");
		const slug = slugify(cleaned, opts);
		if (slug) return slug;
	}
	return fallback;
}
