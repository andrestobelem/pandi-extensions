/**
 * Time-formatting helper, local to this extension so it stays self-contained.
 *
 * INTENTIONAL DUPLICATION: a byte-identical copy lives in every extension that
 * needs it (currently pi-loop and pi-goal) instead of a cross-extension
 * `../shared/` import. Pi loads each extension self-contained — a single file or
 * a directory with its OWN helpers — so reaching into a sibling extension's
 * directory only resolves while the whole package is co-installed and breaks
 * under any per-extension distribution. The function is tiny and stable; keep
 * the copies in sync by hand.
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
