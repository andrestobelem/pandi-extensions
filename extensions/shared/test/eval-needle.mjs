/**
 * NoLiMa-style non-lexical eval primitive (research §4 / §3.7).
 *
 * WHY: Long-context retrieval looks fine on vanilla Needle-In-A-Haystack (NIAH) because
 * the question and the needle share surface tokens — the model can match lexically and
 * never has to "understand" anything. NoLiMa (Modarressi et al., ICML 2025,
 * https://arxiv.org/abs/2502.05167) removes that lexical overlap and finds retrieval
 * COLLAPSES (e.g. GPT-4o 99.3% → 69.7% at 32K). GSM-IC (Shi et al.,
 * https://arxiv.org/abs/2302.00093) shows the worst distractors are the ones that DO
 * share surface tokens with the query (lexical lures).
 *
 * CONVENTION for any future context/retrieval eval in this repo:
 *   1. The NEEDLE must be lexically DISJOINT from the QUERY — the link is semantic, not
 *      a string match. (Enforced by assertNonLexicalDesign.)
 *   2. Include DISTRACTORS that DO overlap the query lexically — the lures NoLiMa/GSM-IC
 *      punish. An eval with no lexical lure is too easy. (Also enforced.)
 *   3. NEVER gate the pass condition on the literal needle string. Grade non-lexically on
 *      an explicit set of acceptable paraphrase keys (`accept`) and reject the distractor
 *      lures (`reject`). Use gradeNonLexical, not literalGrade — literalGrade is provided
 *      ONLY to demonstrate (in tests) why literal matching is unsafe.
 *
 * Pure ESM, no imports, no fs/ctx/SDK — trivially testable and fail-safe (never throws).
 */

const STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"are",
	"was",
	"were",
	"that",
	"this",
	"with",
	"from",
	"into",
	"your",
	"you",
	"what",
	"which",
	"who",
	"whom",
	"whose",
	"when",
	"where",
	"how",
	"did",
	"does",
	"has",
	"had",
	"have",
	"will",
	"would",
	"can",
	"could",
	"should",
	"about",
	"there",
	"their",
	"they",
	"them",
	"its",
	"his",
	"her",
	"our",
	"out",
	"not",
	"but",
	"all",
	"any",
	"some",
	"one",
	"two",
]);

/** Lowercase, split on non-word chars, drop short tokens and trivial stopwords. */
export function tokenize(text) {
	if (typeof text !== "string" || text.length === 0) return [];
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((tok) => tok.length >= 3 && !STOPWORDS.has(tok));
}

/** The set (as a sorted array) of significant tokens shared by two strings. */
export function lexicalOverlap(a, b) {
	const setB = new Set(tokenize(b));
	const shared = new Set();
	for (const tok of tokenize(a)) {
		if (setB.has(tok)) shared.add(tok);
	}
	return [...shared].sort();
}

/**
 * Assemble a NoLiMa-shaped eval case.
 *
 * @param {object} spec
 * @param {string} spec.query          The question (its tokens are the lexical lure surface).
 * @param {string} spec.needleSentence The sentence containing the fact — MUST be lexically
 *                                      disjoint from `query`.
 * @param {string} [spec.needleAnswer] The fact itself; defaults to needleSentence.
 * @param {string[]} [spec.distractors] Lure sentences (ideally overlapping the query).
 * @param {string[]} [spec.filler]      Neutral filler lines.
 * @param {string[]} [spec.accept]      Paraphrase keys that count as a correct answer.
 * @param {string[]} [spec.reject]      Lure keys that mark a distractor-fooled answer.
 * @param {number} [spec.position]      0..1 fractional position of the needle in the haystack.
 * @returns {{ query, haystack, needleSentence, needleAnswer, accept, reject }}
 */
export function buildNeedleEval(spec = {}) {
	const query = typeof spec.query === "string" ? spec.query : "";
	const needleSentence = typeof spec.needleSentence === "string" ? spec.needleSentence : "";
	const needleAnswer = typeof spec.needleAnswer === "string" && spec.needleAnswer ? spec.needleAnswer : needleSentence;
	const distractors = Array.isArray(spec.distractors) ? spec.distractors.filter((s) => typeof s === "string") : [];
	const filler = Array.isArray(spec.filler) ? spec.filler.filter((s) => typeof s === "string") : [];
	const accept = Array.isArray(spec.accept) ? spec.accept.filter((s) => typeof s === "string" && s) : [];
	const reject = Array.isArray(spec.reject) ? spec.reject.filter((s) => typeof s === "string" && s) : [];

	// Interleave distractors among filler, then insert the needle at the requested position.
	const body = [];
	const lures = [...distractors];
	for (let i = 0; i < filler.length; i++) {
		body.push(filler[i]);
		if (lures.length) body.push(lures.shift());
	}
	body.push(...lures); // any remaining distractors
	const frac =
		typeof spec.position === "number" && Number.isFinite(spec.position)
			? Math.min(1, Math.max(0, spec.position))
			: 0.5;
	const at = Math.round(frac * body.length);
	body.splice(at, 0, needleSentence);

	return { query, haystack: body.join("\n"), needleSentence, needleAnswer, accept, reject };
}

/**
 * Lint an eval case for the NoLiMa shape. Returns a list of human-readable violations
 * (empty list = a well-formed non-lexical eval). Never throws.
 */
export function assertNonLexicalDesign(evalCase = {}) {
	const problems = [];
	const query = typeof evalCase.query === "string" ? evalCase.query : "";
	const needleSentence = typeof evalCase.needleSentence === "string" ? evalCase.needleSentence : "";
	const haystack = typeof evalCase.haystack === "string" ? evalCase.haystack : "";

	const needleShared = lexicalOverlap(query, needleSentence);
	if (needleShared.length > 0) {
		problems.push(`needle shares query tokens (must be non-lexical): ${needleShared.join(", ")}`);
	}

	// At least one haystack line other than the needle must lexically overlap the query
	// (a lexical lure). Otherwise the eval has no distractor pressure.
	const lines = haystack.split(/\r?\n/).filter((l) => l.trim() && l !== needleSentence);
	const hasLure = lines.some((line) => lexicalOverlap(query, line).length > 0);
	if (!hasLure) {
		problems.push("no distractor overlaps the query (add a lexical-lure distractor)");
	}

	if (Array.isArray(evalCase.accept) && evalCase.accept.length === 0) {
		problems.push("no `accept` paraphrase keys (grading would fall back to literal matching)");
	}
	return problems;
}

/**
 * UNSAFE reference grader: literal substring match against the needle text. Provided ONLY
 * so tests can demonstrate how literal matching is fooled. Do NOT gate real evals on this.
 */
export function literalGrade(answer, needleSentence) {
	if (typeof answer !== "string" || typeof needleSentence !== "string" || !needleSentence) return false;
	return answer.toLowerCase().includes(needleSentence.toLowerCase());
}

/**
 * Non-lexical grader: pass iff the answer contains at least one `accept` paraphrase key AND
 * matches NO `reject` distractor lure (zero-tolerance — a single reject-key hit fails the
 * answer, so the caller must choose reject keys that are specific to the distractors and would
 * not legitimately appear in a correct answer). Case-insensitive substring presence on the
 * SEMANTIC keys (not the needle sentence), so a paraphrase passes and a lure-echo fails.
 *
 * @returns {{ pass: boolean, matchedAccept: string[], matchedReject: string[] }}
 */
export function gradeNonLexical(answer, opts = {}) {
	const text = typeof answer === "string" ? answer.toLowerCase() : "";
	const accept = Array.isArray(opts.accept) ? opts.accept.filter((s) => typeof s === "string" && s) : [];
	const reject = Array.isArray(opts.reject) ? opts.reject.filter((s) => typeof s === "string" && s) : [];
	const matchedAccept = accept.filter((key) => text.includes(key.toLowerCase()));
	const matchedReject = reject.filter((key) => text.includes(key.toLowerCase()));
	// Pass only when a correct paraphrase is present and no distractor lure is matched.
	const pass = matchedAccept.length > 0 && matchedReject.length === 0;
	return { pass, matchedAccept, matchedReject };
}
