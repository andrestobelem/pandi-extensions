/**
 * Pure kaomoji panda faces + the animation sequence for Pandi's "kaomoji" working
 * indicator. No SDK, no I/O, no randomness at module load: importing this file is
 * side-effect free, so it can be unit-tested in isolation (index.ts is the only
 * orchestration layer, where the theme color + interval are applied).
 *
 * Why this exists: the animated indicator used to render a single `ʕ•ᴥ•ʔ` shape forever
 * (only the eyes blinked), so the moving carita never really changed. These are the
 * expressions we designed — the sequence rotates through them so Pandi actually emotes
 * while pi thinks.
 */

/** The panda's snout (U+1D25 LATIN LETTER SMALL CAPITAL L WITH BAR) — every face carries it. */
export const PANDA_SNOUT = "ᴥ";

/**
 * The designed kaomoji panda expressions — the single source of Pandi's faces (index.ts
 * reuses these for greetings/notifications too). Each keeps the `ᴥ` snout so it reads as
 * Pandi.
 */
export const KAOMOJI_PANDAS = {
	basico: "ʕ •ᴥ• ʔ", // panda básico
	ojitos: "ʕ ◕ᴥ◕ ʔ", // ojitos grandes
	llorando: "ʕ ╥ᴥ╥ ʔ", // llorando
	decidido: "ʕ òᴥó ʔ", // decidido (glifos precompuestos ò/ó: sin marcas combinantes frágiles)
	gatuno: "(=◕ᴥ◕=)", // gatuno-panda
	feliz: "ʕ ^ᴥ^ ʔ", // ojito feliz
	parpadeo: "ʕ -ᴥ- ʔ", // parpadeo
} as const;

/** One animation step: which face to show and how many trailing "…" dots (0–3). */
export interface KaomojiFrame {
	/** The panda face for this frame (a value of {@link KAOMOJI_PANDAS}). */
	face: string;
	/** Trailing dot count (0–3) that trails behind the face while it thinks. */
	dots: number;
}

/**
 * The animation loop. It cycles through several designed expressions (not just eye
 * blinks) so the moving carita visibly changes: básico → ojitos → decidido → parpadeo →
 * gatuno → ojitos → feliz. Kept as plain data so index.ts wires the theme color/interval.
 */
export const KAOMOJI_SEQUENCE: readonly KaomojiFrame[] = [
	{ face: KAOMOJI_PANDAS.basico, dots: 0 },
	{ face: KAOMOJI_PANDAS.basico, dots: 1 },
	{ face: KAOMOJI_PANDAS.ojitos, dots: 2 },
	{ face: KAOMOJI_PANDAS.decidido, dots: 3 },
	{ face: KAOMOJI_PANDAS.parpadeo, dots: 3 }, // parpadeo
	{ face: KAOMOJI_PANDAS.gatuno, dots: 2 },
	{ face: KAOMOJI_PANDAS.ojitos, dots: 1 },
	{ face: KAOMOJI_PANDAS.feliz, dots: 0 }, // ojito feliz
] as const;
