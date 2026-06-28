/**
 * Shared session-state replay kernel for the loop/goal/plan family.
 *
 * Each of those extensions persists its state by appending a "custom" session
 * entry (pi.appendEntry<T>(STATE_TYPE, snapshot)) and, on session_start, rebuilds
 * the latest snapshot per id by scanning ctx.sessionManager.getEntries() with
 * last-wins semantics. That scan was byte-identical in all three (modulo the
 * customType constant and the id field), so it lives here once.
 *
 * Deliberately ONLY the pure latest-by-key collection: the divergent recovery
 * logic that runs afterwards (active-vs-terminal gating, sidecar conflict
 * resolution, autonomous retirement, re-arming) stays in each extension, because
 * those are genuinely different state machines, not duplication.
 *
 * The entry parameter is structural (PersistedEntry) so this module does not
 * couple to a specific SDK entry type. Depth-one sibling under extensions/shared.
 */

/** Structural shape of a session entry this kernel inspects. */
export interface PersistedEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/**
 * Build a Map of the latest snapshot per key from append-only session entries,
 * keeping only entries whose type is "custom" and whose customType matches, and
 * whose extracted key is a string. Last write wins (entries are scanned in order;
 * Map.set overwrites). Behavior-identical to the inline loop it replaces.
 *
 * @param entries    session entries in append order (oldest -> newest)
 * @param customType the appendEntry customType discriminator (e.g. "loop-state")
 * @param keyOf      extracts the id used as the Map key (must be a string to keep)
 */
export function collectLatestByKey<T>(
	entries: Iterable<PersistedEntry>,
	customType: string,
	keyOf: (data: T) => unknown,
): Map<string, T> {
	const latest = new Map<string, T>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== customType) continue;
		const data = entry.data as T | undefined;
		if (!data) continue;
		const key = keyOf(data);
		if (typeof key !== "string") continue;
		latest.set(key, data);
	}
	return latest;
}
