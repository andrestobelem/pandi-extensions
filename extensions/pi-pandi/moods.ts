/**
 * Pure data + helpers for Pandi's playful status text. No SDK, no I/O, no randomness at
 * module load: importing this file is side-effect free, so it can be unit-tested in
 * isolation (the extension's index.ts is the only orchestration layer).
 *
 * Tone contract: every MOOD is a short, gentle "bamboo-forest" gerund/phrase — tierno y
 * zen, with the occasional soft dev wink ("acomodando los bytes…", "rumiando los
 * tokens…"). Each one must read naturally in BOTH templates the indicator uses:
 *   `Pandi ${mood}`              e.g. "Pandi trepando el bambú…"
 *   `Pandi despierto y ${mood}`  e.g. "Pandi despierto y trepando el bambú…"
 * and each ends with a single ellipsis character "…" (U+2026), lowercase, trimmed.
 */

/**
 * Two-line splash quote shown on start (kept as-is; not a MOOD). The wording is a meme —
 * the spelling is intentional, do not "fix" it 🐼.
 */
export const PANDI_QUOTE = [
	"Pobres pandas, toda la vida masticando bambú…",
	"…lo que es yo, yo quiero todo el menú.",
] as const;

/** Playful gerunds that rotate per turn. Tone: tierno/zen del bosque de bambú. */
export const MOODS = [
	"rumiando bambú…",
	"masticando bambú…",
	"masticando ideas…",
	"pensando…",
	"tramando algo…",
	"haciendo cálculos pandescos…",
	"consultando al bosque de bambú…",
	"queriendo todo el menú…",
	"meditando bajo un árbol…",
	"estirándose al sol…",
	"buscando la mejor rama…",
	"acomodando los bytes…",
	"trepando el bambú…",
	"pelando un brote de bambú…",
	"siguiendo el rastro del bosque…",
	"ordenando ramas y hojas…",
	"olfateando ideas frescas…",
	"rumiando los tokens…",
	"contando anillos del bambú…",
	"respirando la brisa del bambudal…",
	"puliendo cada hoja…",
	"enroscado entre las ramas…",
] as const;

/** Pick a uniformly-random element. Always returns a member of a non-empty array. */
export const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]!;
