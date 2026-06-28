/**
 * Pure helpers for the model-callable `remember` tool — the WRITE side of
 * pi-local-memory. Kept side-effect free (no fs) so the append/dedup policy is
 * trivially testable in isolation; index.ts owns the actual file IO.
 *
 * Layout (Claude-style): durable notes live under the `.pi/memory/` FOLDER.
 *   - `.pi/memory/MEMORY.md` is the INDEX/entrypoint, injected at startup (capped).
 *   - `.pi/memory/<topic>.md` are TOPIC files, read on demand — never auto-injected.
 *
 * The design constraint: Pi may persist durable notes ON ITS OWN, but it must
 * NEVER clobber human-curated content. So every agent-written note lives inside
 * a single MANAGED BLOCK delimited by HTML-comment markers, always kept at the
 * END of the target file. Everything outside the markers is the human's and is
 * left byte-for-byte untouched.
 *
 * Depth-one sibling module imported by index.ts via "./memory.js"; typechecked
 * transitively (tsconfig includes extensions/**\/*.ts).
 */

/** Marker that opens the agent-managed block. */
export const REMEMBER_BEGIN = "<!-- pi:remember:begin -->";
/** Marker that closes the agent-managed block. */
export const REMEMBER_END = "<!-- pi:remember:end -->";
/** Heading shown to a human reading MEMORY.md, so the managed block is obvious. */
export const MANAGED_HEADING = "## Agent memory (auto-managed by the remember tool)";

/** Upper bound on a single note (clamped inside execute; never trust the model). */
export const MAX_NOTE_LENGTH = 1000;

/**
 * Normalize a raw note into a single clean line: collapse whitespace/newlines,
 * trim, and cap the length. Returns "" when there is nothing left to store.
 */
export function normalizeNote(raw: string): string {
	return raw.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_LENGTH);
}

/** Strip the `- <date>: ` bullet prefix so two notes can be compared by text only. */
function bulletNoteText(line: string): string {
	return line.replace(/^-\s+\d{4}-\d{2}-\d{2}:\s+/, "").trim();
}

/**
 * Append `note` (as a dated bullet) to the managed block of a MEMORY.md document.
 *
 * - No managed block yet → create one at the END (preceded by the existing content,
 *   if any, so human notes stay on top).
 * - Managed block present → insert the new bullet just before the END marker.
 * - Idempotent: if the exact note text already exists in the managed block, return
 *   the document unchanged with `added: false`.
 *
 * Pure: returns the new document text; the caller decides whether/where to write it.
 */
export function upsertMemoryNote(existing: string, note: string, date: string): { content: string; added: boolean } {
	const bullet = `- ${date}: ${note}`;
	const begin = existing.indexOf(REMEMBER_BEGIN);
	const end = existing.indexOf(REMEMBER_END);
	const hasBlock = begin !== -1 && end !== -1 && end > begin;

	if (!hasBlock) {
		const base = existing.replace(/\s+$/, "");
		const sep = base.length ? `${base}\n\n` : "";
		const block = `${REMEMBER_BEGIN}\n${MANAGED_HEADING}\n\n${bullet}\n${REMEMBER_END}\n`;
		return { content: `${sep}${block}`, added: true };
	}

	// Dedup within the managed block (markers + heading + bullets), comparing on note text.
	const block = existing.slice(begin, end);
	const already = block.split("\n").some((line) => bulletNoteText(line) === note);
	if (already) return { content: existing, added: false };

	// Insert the new bullet right before the END marker, keeping one clean newline.
	const head = existing.slice(0, end).replace(/\s+$/, "");
	const tail = existing.slice(end); // begins with REMEMBER_END
	return { content: `${head}\n${bullet}\n${tail}`, added: true };
}

// ===========================================================================
// Folder layout helpers (Claude-style): a `.pi/memory/` directory with a single
// injected INDEX plus on-demand topic files. All pure: callers in index.ts join
// these against cwd and own the actual fs.
// ===========================================================================

/** Directory (relative to `.pi/`) that holds the memory index + topic files. */
export const MEMORY_DIR = "memory";
/** The injected entrypoint inside the memory folder. */
export const INDEX_FILE = "MEMORY.md";

/** Injection caps for the index, mirroring Claude: first 200 lines OR 25 KB. */
export const MAX_INJECT_LINES = 200;
export const MAX_INJECT_BYTES = 25_000;
/** Upper bound on a topic slug length, so a runaway title can't make a huge name. */
export const MAX_SLUG_LENGTH = 64;

/**
 * Turn a free-form topic title into a SAFE single-segment filename slug.
 *
 * Collapses every non-alphanumeric run (including `/`, `\\`, `.`, `..`, spaces) to
 * a single hyphen, lowercases, trims hyphens, and caps the length. This makes path
 * traversal structurally impossible: `"../../etc/passwd"` -> `"etc-passwd"`,
 * `"../"` -> `""`. Returns "" when nothing safe remains (caller must reject).
 */
export function slugifyTopic(raw: string): string {
	return raw
		.replace(/\.md$/i, "") // tolerate callers passing "debugging.md"
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_SLUG_LENGTH);
}

/** Clip a UTF-8 string to at most `maxBytes`, trimming any split-codepoint tail. */
function clipByBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	return Buffer.from(text, "utf8")
		.subarray(0, maxBytes)
		.toString("utf8")
		.replace(/\uFFFD+$/, ""); // drop a trailing replacement char from a cut multibyte seq
}

/**
 * Cap text for injection: first `maxLines` lines, then clamp to `maxBytes` bytes.
 * Returns the (possibly clipped) text plus whether anything was truncated.
 */
export function capForInjection(
	text: string,
	maxLines = MAX_INJECT_LINES,
	maxBytes = MAX_INJECT_BYTES,
): { text: string; truncated: boolean } {
	let truncated = false;
	const lines = text.split("\n");
	let out = text;
	if (lines.length > maxLines) {
		out = lines.slice(0, maxLines).join("\n");
		truncated = true;
	}
	if (Buffer.byteLength(out, "utf8") > maxBytes) {
		out = clipByBytes(out, maxBytes);
		truncated = true;
	}
	return { text: out, truncated };
}

/** Escape literal local_memory tags so file content can't break out of the fence. */
export function escapeLocalMemoryTags(text: string): string {
	return text.replace(/<\/?local_memory/gi, (match) => match.replace("<", "&lt;"));
}

/**
 * Build the fully-escaped BODY injected inside the <local_memory> block: the capped
 * index, an optional truncation marker, and a listing of on-demand topic files (paths
 * only — their contents are NOT injected; the agent reads them with its file tools).
 */
export function composeInjectedMemory(args: {
	indexText: string;
	topicNames: string[];
	memoryDirPath: string;
}): string {
	const { text: capped, truncated } = capForInjection(args.indexText.trim());
	const parts = [capped];
	if (truncated) {
		parts.push("\n… (memory index truncated for injection; open MEMORY.md to read the rest)");
	}
	if (args.topicNames.length) {
		const list = args.topicNames.map((name) => `- ${args.memoryDirPath}/${name}`).join("\n");
		parts.push(`\n## Topic files (read on demand with your file tools)\n\n${list}`);
	}
	return escapeLocalMemoryTags(parts.join("\n"));
}
