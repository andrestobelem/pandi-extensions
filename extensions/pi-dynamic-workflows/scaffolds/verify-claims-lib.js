/**
 * lib/verify-claims — reusable composable sub-workflow.
 *
 * Contract: { claims:[{id, claim, evidence?}], skeptics?: number, topic?: string }
 * Returns: { verified, dropped, votes, coverage }
 *
 * This file is intended to live at `.pi/workflows/lib/verify-claims.js` and be
 * called from parent workflows with ctx.workflow("lib/verify-claims", args).
 */
module.exports = async function workflow(ctx, input) {
	const claims = Array.isArray(input?.claims) ? input.claims.filter((claim) => claim?.claim) : [];
	if (claims.length === 0) return { verified: [], dropped: [], votes: [], coverage: { claims: 0 } };
	const requestedSkeptics = Math.max(1, Number.isFinite(+input?.skeptics) ? Math.floor(+input.skeptics) : 3);
	const skeptics = Math.min(requestedSkeptics, ctx.limits.concurrency);
	if (skeptics < requestedSkeptics)
		await ctx.log("skeptic cap applied", {
			requested: requestedSkeptics,
			running: skeptics,
			concurrency: ctx.limits.concurrency,
		});

	const VERDICT = {
		type: "object",
		additionalProperties: false,
		required: ["refuted", "confidence", "evidence", "why"],
		properties: {
			refuted: { type: "boolean" },
			confidence: { type: "string", description: "high | medium | low" },
			evidence: { type: "string" },
			why: { type: "string" },
		},
	};

	const votes = [];
	const verified = [];
	const dropped = [];

	for (let i = 0; i < claims.length; i++) {
		const claim = claims[i];
		const jury = await ctx.agents(
			Array.from({ length: skeptics }, (_unused, j) => ({
				name: `verify-${claim.id ?? i}-skeptic-${j + 1}`,
				prompt:
					`You are skeptic ${j + 1}/${skeptics}. Try to REFUTE this claim with concrete evidence. ` +
					`If evidence is insufficient, set refuted=true unless the claim is strongly supported.\n\n` +
					`Topic: ${input?.topic ?? "n/a"}\n` +
					`Claim: ${claim.claim}\n` +
					`Provided evidence: ${claim.evidence ?? "none"}\n\n` +
					`Return JSON only matching the schema.`,
				agentType: "reviewer",
				tools: ["read", "grep", "find", "ls", "bash"],
				schema: VERDICT,
				schemaOnInvalid: "null",
			})),
			{ concurrency: skeptics, settle: true },
		);
		// F1: harmonized with adversarial-verify - strict majority of the FIXED jury kills,
		// and a crashed/invalid skeptic fails CLOSED (counts as a refutation); ties survive.
		const majority = Math.floor(skeptics / 2) + 1;
		const cast = jury.map((r) =>
			r?.data && typeof r.data.refuted === "boolean"
				? r.data
				: { refuted: true, confidence: "low", evidence: "", why: "skeptic failed/invalid -> default refuted" },
		);
		const refutations = cast.filter((vote) => vote.refuted).length;
		const survived = refutations < majority;
		const record = {
			claim,
			parsedVotes: cast,
			failedBranches: jury.filter((r) => !r?.data).length,
			refutations,
			survived,
		};
		votes.push(record);
		if (survived) verified.push({ ...claim, verification: record });
		else dropped.push({ ...claim, verification: record });
		await ctx.log("claim verification complete", {
			index: i + 1,
			total: claims.length,
			survived,
			refutations,
			votes: cast.length,
			failedBranches: record.failedBranches,
		});
	}

	const result = { verified, dropped, votes, coverage: { claims: claims.length, skeptics, requestedSkeptics } };
	await ctx.writeArtifact("verify-claims-result.json", result);
	return result;
};
