/**
 * Session-state replay kernel, local to this extension so it stays self-contained.
 *
 * INTENTIONAL DUPLICATION: a byte-identical copy lives in each of the loop/goal/
 * plan extensions that needs it instead of a cross-extension `../shared/` import.
 * Pi loads each extension self-contained (a single file or a directory with its
 * OWN helpers, via jiti filesystem resolution), so a `../shared/` import only
 * resolves while the whole package is co-installed and breaks under per-extension
 * distribution. Keep the copies in sync by hand.
 *
 * Only the PURE latest-by-key collection lives here; the divergent recovery logic
 * that runs afterwards (active-vs-terminal gating, sidecar conflict resolution,
 * autonomous retirement, re-arming) stays in each extension's index.ts because
 * those are genuinely different state machines, not duplication.
 *
 * The entry parameter is structural (PersistedEntry) so this does not couple to a
 * specific SDK entry type.
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
