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
export const MAX_NAME_WORDS = 4;

/**
 * Connector words (articles, prepositions, conjunctions) a session NAME should not end
 * on. The point is to describe the session in a few words without leaving the slug
 * dangling mid-phrase (e.g. "arreglar-el-bug-de" -> "arreglar-el-bug"). Spanish + English
 * function words only; content words are never trimmed. Lowercase, ASCII, matching the
 * post-slugify tokens.
 */
const TRAILING_CONNECTORS = new Set<string>([
	// Spanish
	"el",
	"la",
	"los",
	"las",
	"un",
	"una",
	"unos",
	"unas",
	"lo",
	"al",
	"del",
	"de",
	"a",
	"en",
	"con",
	"por",
	"para",
	"sin",
	"sobre",
	"entre",
	"hasta",
	"hacia",
	"desde",
	"ante",
	"tras",
	"y",
	"o",
	"u",
	"e",
	"ni",
	"que",
	"se",
	"su",
	"sus",
	"mi",
	"tu",
	// English
	"the",
	"an",
	"of",
	"to",
	"for",
	"in",
	"on",
	"at",
	"by",
	"and",
	"or",
	"with",
	"from",
	"as",
	"is",
	"this",
	"that",
	"into",
	"onto",
]);

/**
 * Drop trailing connector segments from a hyphenated slug so a name never ends on a
 * dangling article/preposition/conjunction. Always keeps at least one segment, so an
 * all-connector slug is left non-empty rather than collapsing to "".
 */
function trimTrailingConnectors(slug: string): string {
	if (!slug) return slug;
	const parts = slug.split("-");
	while (parts.length > 1 && TRAILING_CONNECTORS.has(parts[parts.length - 1])) parts.pop();
	return parts.join("-");
}

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
 * hard-truncated so the result is never empty when there was content), then drops any
 * trailing connector words so the slug reads as a short name and never ends mid-phrase
 * on a dangling article/preposition/conjunction. Returns "" when there is nothing
 * slug-able.
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
	// Keep the name short but never ending on a dangling connector word.
	return trimTrailingConnectors(slug);
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
 * Derive a slug session name from the conversation history, reflecting what the user is
 * doing NOW. Walks entries from the MOST RECENT backward and uses the latest `user`
 * message that yields a non-empty slug (a leading slash-command token is dropped first,
 * so a bare `/rename` invocation or an empty turn is skipped and the previous real
 * instruction wins). Because it reads the latest activity rather than the first message,
 * calling `/rename` again as the conversation evolves produces a fresh, current name
 * instead of being stuck on how the session opened. Returns the default name when no
 * user message yields a slug.
 */
export function deriveSessionName(entries: unknown, opts: DeriveOptions = {}): string {
	const fallback = opts.defaultName ?? DEFAULT_SESSION_NAME;
	const list = Array.isArray(entries) ? entries : [];
	for (let i = list.length - 1; i >= 0; i--) {
		const raw = extractUserText(list[i]);
		if (!raw) continue;
		// Drop a leading slash-command token, e.g. "/explain the cache" -> "the cache".
		const cleaned = raw.replace(/^\s*\/[a-zA-Z][\w-]*\s*/, "");
		const slug = slugify(cleaned, opts);
		if (slug) return slug;
	}
	return fallback;
}
