/**
 * loop-engineering-verified-refine — a BOUNDED refine loop closed by an
 * INDEPENDENT verifier.
 *
 * This is the direct operationalization of the one-line lesson from
 * docs/research/2026-06-28-loop-engineering.md (see also
 * docs/loop-engineering-with-extensions.md):
 *
 *   "Bound the loop AND keep the critique signal independent and unbiased."
 *
 * A single model that judges its OWN work is unreliable (Huang et al.,
 * arXiv:2310.01798): purely intrinsic self-correction can flip correct answers
 * to wrong. So here the GENERATOR never decides it is done — a SEPARATE,
 * read-only VERIFIER (reviewer persona) emits `VERDICT: PASS|FAIL` against the
 * success criteria, and ONLY an independent PASS stops the loop. This mirrors
 * the /goal extension's `verifying-independent` design, expressed as a reusable
 * dynamic workflow over an arbitrary text artifact.
 *
 * Loop-engineering principles demonstrated (research §4):
 *  - Bounded termination .................. maxRounds (never an infinite loop)
 *  - Actuator clamp ("don't trust the model") ... maxRounds saturated to [1,8]
 *  - Convergence on EVIDENCE .............. stop on an independent PASS, not a
 *                                           self-declaration
 *  - Oscillation guard (limit cycle) ...... identical blocking critique twice
 *                                           -> BLOCKED (a switch count, not tuning)
 *  - Independent, unbiased critique signal  verifier is a separate reviewer that
 *                                           "did not write this; judge it"
 *  - No silent caps ....................... logs when it stops at maxRounds
 *                                           WITHOUT a PASS (not converged)
 *
 * Safety: this workflow does NOT edit repo files. It refines a TEXT draft passed
 * through agent outputs and persists every round (draft + verdict) as run-dir
 * artifacts, so the entire loop is inspectable. Read-only tools only.
 *
 * Run it (from the repo root):
 *   /workflow run loop-engineering-verified-refine {"task":"Write a precise PR description for the last commit","criteria":"covers what/why, lists files, no claims without evidence"}
 *
 * Input:
 *   { task: string,           // what to produce / refine
 *     criteria?: string,      // success criteria the verifier checks (defaults to task)
 *     draft?: string,         // optional initial draft (else round 0 generates one)
 *     maxRounds?: number = 4, // clamped to [1,8]; Self-Refine caps experiments at 4
 *     context?: string }      // optional grounding text the agents may use
 */
module.exports = async function workflow(ctx, input = {}) {
	const task = String(input.task || "").trim();
	if (!task) {
		await ctx.log("loop-engineering-verified-refine: no `task` given; nothing to do");
		return { converged: false, rounds: 0, error: "missing input.task" };
	}
	const criteria = String(input.criteria || task).trim();
	const context = input.context ? String(input.context) : "";
	const groundingBlock = context ? `\n\nGROUNDING (read-only context):\n${ctx.compact(context, 4000)}` : "";
	const readOnly = ["read", "grep", "find", "ls"];

	// Actuator clamp: never trust the caller/model with an unbounded or absurd cap.
	// Self-Refine's experiments cap at 4 iterations (diminishing returns after ~3).
	const MIN_ROUNDS = 1;
	const MAX_ROUNDS = 8;
	const requested = Number.isFinite(input.maxRounds) ? Math.trunc(input.maxRounds) : 4;
	const maxRounds = Math.max(MIN_ROUNDS, Math.min(MAX_ROUNDS, requested));
	if (maxRounds !== requested) {
		await ctx.log(`clamped maxRounds ${requested} -> ${maxRounds} (safe band [${MIN_ROUNDS},${MAX_ROUNDS}])`);
	}

	// Anchor the verdict to the LAST non-empty match so it cannot be forged by echoing
	// the prompt earlier in the output; no parseable verdict -> conservative FAIL.
	const parseVerdict = (text) => {
		const lines = String(text || "")
			.trim()
			.split(/\r?\n/);
		for (let i = lines.length - 1; i >= 0; i--) {
			const m = lines[i].match(/VERDICT:\s*(PASS|FAIL)/i);
			if (m) return m[1].toUpperCase();
		}
		return "FAIL"; // no verdict -> never a blind PASS
	};

	// ---- Round 0: produce an initial draft if none was supplied. ----
	let draft = input.draft ? String(input.draft) : null;
	if (!draft) {
		await ctx.log("verified-refine: round 0 — generating initial draft");
		const gen = await ctx.agent(
			`You are the GENERATOR. Produce a first, concrete, complete draft for this task.\n\n` +
				`TASK:\n${task}\n\nSUCCESS CRITERIA:\n${criteria}${groundingBlock}`,
			{ name: "generate-0", agentType: "implementer", tools: readOnly },
		);
		draft = gen.output || "";
	}
	await ctx.writeArtifact("draft-0.md", draft);

	// ---- Bounded refine loop, closed ONLY by an independent PASS. ----
	let verdict = "FAIL";
	let lastBlocking = null; // signature of the previous critique, for the oscillation guard
	let blocked = false;
	const history = [];

	for (let round = 1; round <= maxRounds; round++) {
		// (a) INDEPENDENT verification — a separate read-only reviewer judges the draft.
		await ctx.log(`verified-refine: round ${round}/${maxRounds} — independent verify`);
		const review = await ctx.agent(
			`You are an INDEPENDENT VERIFIER. You did NOT write the draft below; judge it adversarially ` +
				`against the success criteria. Do not be charitable. A claim without verifiable support is a FAIL.\n\n` +
				`SUCCESS CRITERIA:\n${criteria}${groundingBlock}\n\n` +
				`DRAFT UNDER REVIEW:\n${ctx.compact(draft, 12000)}\n\n` +
				`List the BLOCKING issues (each: what is wrong + the localized, actionable fix). If there are none ` +
				`and the draft meets every criterion, say so. End with EXACTLY one line:\n` +
				`VERDICT: PASS   (meets all criteria)\nVERDICT: FAIL   (one or more blocking issues remain)`,
			{ name: `verify-${round}`, agentType: "reviewer", tools: readOnly },
		);
		verdict = parseVerdict(review.output);
		await ctx.writeArtifact(`verdict-${round}.md`, review.output || "");
		history.push({ round, verdict });

		if (verdict === "PASS") {
			await ctx.log(`verified-refine: round ${round} — independent PASS; converged on evidence`);
			break;
		}

		// Oscillation guard: if the independent critique is essentially identical to the
		// previous round's, we are not making progress -> stop as BLOCKED. This is a hard
		// switch count, not better tuning (research failure mode: "limit cycle").
		const sig = (review.output || "").replace(/\s+/g, " ").trim().slice(0, 800);
		if (lastBlocking && sig && sig === lastBlocking) {
			await ctx.log(`verified-refine: round ${round} — same blocking critique as last round; BLOCKED (no progress)`);
			blocked = true;
			break;
		}
		lastBlocking = sig;

		// Don't generate a draft we cannot then verify within the budget.
		if (round === maxRounds) break;

		// (b) REFINE — the GENERATOR applies ONLY the verifier's actionable critique
		// (localized edits, Self-Refine style). It never gets to declare success itself.
		await ctx.log(`verified-refine: round ${round} — refine against critique`);
		const refined = await ctx.agent(
			`You are the GENERATOR. Revise the draft to fix ONLY the blocking issues the independent verifier ` +
				`raised — make localized, actionable edits; do not rewrite wholesale or add unrequested scope.\n\n` +
				`TASK:\n${task}\n\nSUCCESS CRITERIA:\n${criteria}${groundingBlock}\n\n` +
				`CURRENT DRAFT:\n${ctx.compact(draft, 12000)}\n\n` +
				`VERIFIER CRITIQUE:\n${ctx.compact(review.output, 6000)}\n\nReturn the FULL revised draft.`,
			{ name: `refine-${round}`, agentType: "implementer", tools: readOnly },
		);
		draft = refined.output || draft;
		await ctx.writeArtifact(`draft-${round}.md`, draft);
	}

	// No silent caps: be explicit about WHY we stopped.
	const converged = verdict === "PASS";
	if (!converged && !blocked) {
		await ctx.log(`verified-refine: stopped at maxRounds=${maxRounds} WITHOUT an independent PASS (not converged)`);
	}

	await ctx.writeArtifact(
		"verified-refine.json",
		JSON.stringify({ task, criteria, maxRounds, roundsRun: history.length, converged, blocked, history }, null, 2),
	);
	await ctx.writeArtifact("final-draft.md", draft || "");

	return {
		converged,
		blocked,
		rounds: history.length,
		finalVerdict: verdict,
		stopReason: converged ? "independent PASS" : blocked ? "oscillation (no progress)" : "maxRounds reached",
		finalDraft: draft || "",
	};
};
