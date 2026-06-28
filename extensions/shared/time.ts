/**
 * Shared time-formatting helpers for Pi extensions.
 *
 * Extracted verbatim from the byte-identical copies that previously lived in
 * `pi-loop/index.ts` and `pi-goal/index.ts` (DRY; behavior-preserving).
 *
 * This module lives at depth one under `extensions/` so it matches the
 * `package.json` `files` glob (one level deep) and is typechecked
 * transitively via the `.js` import from each extension's `index.ts`.
 */

/**
 * Human-friendly "time until next fire" label for a status line.
 *
 * - `null`      -> "now" (no scheduled wake)
 * - < 60s       -> "<n>s"
 * - >= 60s      -> "<n>m" (rounded to whole minutes)
 *
 * Never returns a negative value: past timestamps clamp to 0.
 */
export function formatEta(nextFireAt: number | null): string {
	if (nextFireAt === null) return "now";
	const secs = Math.max(0, Math.round((nextFireAt - Date.now()) / 1000));
	if (secs >= 60) return `${Math.round(secs / 60)}m`;
	return `${secs}s`;
}
