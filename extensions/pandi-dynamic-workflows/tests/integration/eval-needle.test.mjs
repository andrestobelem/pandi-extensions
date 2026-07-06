#!/usr/bin/env node

/**
 * Tests for the NoLiMa-style non-lexical eval primitive (research §4 / §3.7).
 *
 * These prove the eval-DESIGN contract offline (no live model needed): the builder yields
 * a needle lexically disjoint from the query with a lexical-lure distractor, the design
 * lint flags malformed cases, and — the money shot — a literal substring grader is FOOLED
 * by a distractor while the non-lexical grader stays robust (accepts a paraphrase, rejects
 * the lure).
 */

import {
	assertNonLexicalDesign,
	buildNeedleEval,
	gradeNonLexical,
	lexicalOverlap,
	literalGrade,
	tokenize,
} from "../../../shared/test/eval-needle.mjs";
import { createChecker } from "../../../shared/test/harness.mjs";

const { check, counts } = createChecker();

// A NoLiMa-shaped case: the QUERY asks who can enter a secure area; the NEEDLE states the
// fact WITHOUT sharing the query's surface tokens (the link is semantic: "clearance" ⇒
// "enter the vault"); a DISTRACTOR echoes the query tokens ("enter", "vault") as a lure.
const query = "Who is allowed to enter the vault?";
const needleSentence = "Dr. Okonkwo holds top-secret clearance for the basement chamber.";
const distractor = "Visitors must not enter the vault without an escort.";
const filler = ["The cafeteria serves lunch at noon.", "Quarterly results were published in March."];

const evalCase = buildNeedleEval({
	query,
	needleSentence,
	needleAnswer: "Dr. Okonkwo",
	distractors: [distractor],
	filler,
	accept: ["okonkwo"],
	reject: ["visitors", "escort"],
	position: 0.5,
});

async function main() {
	// 1) tokenize / lexicalOverlap basics.
	check(
		"tokenize drops stopwords and short tokens",
		!tokenize("Who is the one?").includes("who") && !tokenize("a to in").length,
	);
	check(
		"lexicalOverlap finds shared significant tokens",
		lexicalOverlap("enter the vault now", "do not enter the vault").join(",") === "enter,vault",
	);
	check("lexicalOverlap is empty for disjoint text", lexicalOverlap("alpha bravo", "charlie delta").length === 0);

	// 2) Builder: needle is lexically DISJOINT from the query; a distractor IS a lexical lure.
	const needleShared = lexicalOverlap(evalCase.query, evalCase.needleSentence);
	check(
		"builder: needle is lexically disjoint from the query",
		needleShared.length === 0,
		`shared=${needleShared.join(",")}`,
	);
	check("builder: distractor overlaps the query (lexical lure)", lexicalOverlap(query, distractor).length > 0);
	check(
		"builder: haystack contains the needle and the distractor",
		evalCase.haystack.includes(needleSentence) && evalCase.haystack.includes(distractor),
	);
	check(
		"builder: position places the needle in the middle, not the edges",
		!evalCase.haystack.startsWith(needleSentence) && !evalCase.haystack.endsWith(needleSentence),
	);

	// 3) Design lint: a well-formed case has no violations; malformed cases are flagged.
	check(
		"lint: well-formed case has no violations",
		assertNonLexicalDesign(evalCase).length === 0,
		JSON.stringify(assertNonLexicalDesign(evalCase)),
	);
	const lexicalNeedle = buildNeedleEval({
		query,
		needleSentence: "Only staff may enter the vault.", // shares "enter","vault" with the query — BAD
		distractors: [distractor],
		accept: ["staff"],
	});
	const lexProblems = assertNonLexicalDesign(lexicalNeedle);
	check(
		"lint: flags a needle that shares query tokens",
		lexProblems.some((p) => /non-lexical/.test(p)),
		JSON.stringify(lexProblems),
	);
	const noLure = buildNeedleEval({ query, needleSentence, accept: ["okonkwo"], filler: ["unrelated filler line"] });
	check(
		"lint: flags a case with no lexical-lure distractor",
		assertNonLexicalDesign(noLure).some((p) => /lure/.test(p)),
	);
	for (const [label, accept] of [
		["empty accept keys", []],
		["missing accept keys", undefined],
		["non-array accept keys", "okonkwo"],
	]) {
		check(
			`lint: flags ${label}`,
			assertNonLexicalDesign({
				query,
				needleSentence,
				haystack: `${distractor}\n${needleSentence}`,
				...(accept === undefined ? {} : { accept }),
			}).some((p) => /literal/.test(p)),
		);
	}

	// 4) THE MONEY SHOT: literal grader is fooled by the distractor; non-lexical grader is robust.
	// A model that latched onto the lexical lure would answer using the distractor's words.
	const distractorAnswer = "Visitors must not enter the vault without an escort.";
	const paraphraseAnswer = "Access is granted to Dr. Okonkwo, who has the required clearance.";

	check(
		"literal grader: false-NEGATIVE on a correct paraphrase (needle string absent)",
		literalGrade(paraphraseAnswer, needleSentence) === false,
	);
	check(
		"literal grader: FOOLED — matches the distractor echo as if correct",
		literalGrade(distractorAnswer, distractor) === true,
	);

	const goodGrade = gradeNonLexical(paraphraseAnswer, evalCase);
	check("non-lexical grader: ACCEPTS a correct paraphrase", goodGrade.pass === true, JSON.stringify(goodGrade));
	const luredGrade = gradeNonLexical(distractorAnswer, evalCase);
	check(
		"non-lexical grader: REJECTS the distractor lure",
		luredGrade.pass === false && luredGrade.matchedReject.length > 0,
		JSON.stringify(luredGrade),
	);
	check(
		"non-lexical grader: rejects an empty/irrelevant answer",
		gradeNonLexical("I don't know.", evalCase).pass === false,
	);
	// Zero-tolerance is intentional: an otherwise-correct answer that also trips a reject key is
	// FAILED, so callers must choose distractor-specific reject keys. Document it explicitly.
	const collision = gradeNonLexical("A security escort accompanies Dr. Okonkwo into the chamber.", evalCase);
	check(
		"non-lexical grader: zero-tolerance — a reject-key collision fails an otherwise-correct answer",
		collision.pass === false && collision.matchedAccept.length > 0 && collision.matchedReject.includes("escort"),
		JSON.stringify(collision),
	);

	// 5) Fail-safe: garbage inputs never throw.
	check(
		"failsafe: empty inputs do not throw",
		(() => {
			try {
				buildNeedleEval();
				assertNonLexicalDesign();
				gradeNonLexical(undefined, {});
				literalGrade(null, null);
				tokenize(undefined);
				lexicalOverlap(undefined, null);
				return true;
			} catch {
				return false;
			}
		})(),
	);

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.error(counts.failures.join("\n"));
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err?.stack || err);
	process.exit(1);
});
