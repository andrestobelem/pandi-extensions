/**
 * Pure helpers for the model-callable `remember` tool — the WRITE side of
 * pi-local-memory. Kept side-effect free (no fs) so the append/dedup policy is
 * trivially testable in isolation; index.ts owns the actual file IO.
 *
 * The design constraint: Pi may persist durable notes ON ITS OWN, but it must
 * NEVER clobber human-curated content. So every agent-written note lives inside
 * a single MANAGED BLOCK delimited by HTML-comment markers, always kept at the
 * END of MEMORY.md. Everything outside the markers is the human's and is left
 * byte-for-byte untouched.
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
export function upsertMemoryNote(
	existing: string,
	note: string,
	date: string,
): { content: string; added: boolean } {
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
