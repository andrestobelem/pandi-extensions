/**
 * Deterministic per-key occurrence index for the content-addressed resume cache.
 *
 * Extracted verbatim from runWorkflow's former nested `nextOcc`/`occCounters`. Same key
 * (identical call args) → 0, 1, 2, …; distinct keys count independently. `next()` MUST be
 * called in synchronous emission order — that ordering is what makes `occ` (and therefore
 * resume-cache lookups) deterministic.
 *
 * Intentionally PURE and mutex-free: the serialization lives in runWorkflow's
 * `occAssignMutex`, which wraps the WHOLE occ-assignment prologue (persona/access
 * resolution + key computation + this call), not just the counter increment. Reintroducing
 * a lock in here would shrink that critical section and change resume-cache ordering — so
 * this stays a plain counter and the caller owns the mutex.
 */
export class OccurrenceCounter {
	private readonly counters = new Map<string, number>();

	/** Next occurrence index for `key`: same key → 0, 1, 2, …; distinct keys are independent. */
	next(key: string): number {
		const occ = this.counters.get(key) ?? 0;
		this.counters.set(key, occ + 1);
		return occ;
	}
}
