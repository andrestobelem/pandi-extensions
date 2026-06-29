/**
 * Adversarial verify (vote) — per-finding skeptic fan-out that prunes by majority.
 *
 * Findings come from input.findings or are DISCOVERED by an inline finder. For
 * EACH finding we launch N independent skeptics whose only job is to REFUTE it
 * with evidence; if a skeptic is unsure it must default to refuted=true (guilty
 * until proven innocent). A finding survives only if FEWER than a majority of
 * skeptics refute it. The dynamism: the verification fan-out is sized and shaped
 * per finding (each gets its own jury), and survivors are decided by the votes —
 * not by a fixed pass/fail oracle.
 *
 * Uses: ctx.agent (finder), ctx.parallel([thunks]) per finding (jury barrier),
 * ctx.agent({ schema }) for typed skeptic verdicts, result-driven survival.
 */
module.exports = async function workflow(ctx, input) {
	const safeParse = (s) => {
		try {
			return JSON.parse(s);
		} catch {
			return undefined;
		}
	};

	// N skeptics per finding; clamp to the concurrency budget so one jury fits a barrier.
	const skeptics = Math.max(
		1,
		Math.min(Number.isFinite(+input?.skeptics) ? Math.floor(+input.skeptics) : 3, ctx.limits.concurrency),
	);

	// 1) SOURCE the findings: take them as-is, or DISCOVER them with an inline finder.
	let findings = Array.isArray(input?.findings) ? input.findings.filter(Boolean) : null;
	if (!findings) {
		const topic = input?.topic ?? input?.text;
		if (!topic) throw new Error('Pass { findings: [...] } or { topic: "..." } as workflow input.');
		const maxFind = Math.max(1, Number.isFinite(+input?.maxFindings) ? Math.floor(+input.maxFindings) : 8);
		const finder = await ctx.agent(
			`Find up to ${maxFind} concrete, checkable claims about: ${topic}.\n` +
				`Each must be falsifiable (a skeptic could try to refute it with evidence).\n` +
				`Return ONLY a JSON array of { id, claim, evidence }.`,
			{ name: "finder", agentType: "researcher", tools: ["read", "grep", "find", "ls", "bash"] },
		);
		const arr = finder.data ?? safeParse(finder.output);
		findings = (Array.isArray(arr) ? arr : []).slice(0, maxFind);
		await ctx.log(`finder produced ${findings.length} findings (cap ${maxFind})`, { topic });
	}
	if (findings.length === 0) return "No findings to verify.";

	// Normalize to { id, claim, evidence } so prompts and reporting are stable.
	const items = findings.map((f, i) => {
		if (typeof f === "string") return { id: `f${i + 1}`, claim: f, evidence: "" };
		return { id: f.id ?? `f${i + 1}`, claim: f.claim ?? f.title ?? ctx.json(f), evidence: f.evidence ?? "" };
	});

	const VOTE = {
		type: "object",
		additionalProperties: false,
		required: ["refuted", "why"],
		properties: {
			// Default-refuted is the adversarial bias: doubt => kill it.
			refuted: {
				type: "boolean",
				description: "true if the claim is refuted OR you cannot confirm it; default true when unsure",
			},
			why: { type: "string", description: "one sentence with the evidence for your vote" },
		},
	};

	const majority = Math.floor(skeptics / 2) + 1; // strict majority needed to kill a finding
	await ctx.log(`verifying ${items.length} findings`, { skeptics, majority });

	// 2) Per finding, run an independent jury of skeptics (barrier per finding).
	const verified = [];
	for (let fi = 0; fi < items.length; fi++) {
		const item = items[fi];
		const votes = await ctx.parallel(
			Array.from(
				{ length: skeptics },
				(_unused, si) => () =>
					ctx
						.agent(
							`You are skeptic ${si + 1}/${skeptics} for finding ${item.id}. Your job is to REFUTE this claim with evidence; ` +
								`do NOT try to confirm it. If you cannot find solid disproving evidence but also cannot independently confirm it, vote refuted=true (default to doubt).\n\n` +
								`Claim: ${item.claim}\n` +
								`Cited evidence: ${item.evidence || "(none)"}\n\n` +
								`Decide independently — assume the other skeptics may be wrong or may fail.`,
							{
								name: `skeptic-${item.id}-${si + 1}`,
								agentType: "reviewer",
								tools: ["read", "grep", "find", "ls", "bash"],
								schema: VOTE,
								// Independent juries must re-examine each finding, never serve a cached identical hit.
								cache: false,
							},
						)
						.then((r) => r.data ?? safeParse(r.output)),
			),
		);

		// A null thunk (crashed skeptic) counts as a refute — fail closed, stay adversarial.
		const cast = votes.map((v) =>
			v && typeof v.refuted === "boolean"
				? v
				: { refuted: true, why: "skeptic failed/invalid -> default refuted" },
		);
		const refutes = cast.filter((v) => v.refuted).length;
		const survived = refutes < majority;
		await ctx.log(`finding ${item.id}: ${refutes}/${skeptics} refuted -> ${survived ? "SURVIVED" : "KILLED"}`);
		verified.push({ ...item, refutes, skeptics, survived, votes: cast });
	}

	const survivors = verified.filter((v) => v.survived);
	const killed = verified.length - survivors.length;
	await ctx.log(`verification complete: ${survivors.length} survived, ${killed} killed`, { total: verified.length });
	await ctx.writeArtifact("verification.json", verified);

	return {
		survivors: survivors.map(({ votes, ...keep }) => keep),
		killedCount: killed,
		totalFindings: verified.length,
		skepticsPerFinding: skeptics,
		majorityToKill: majority,
	};
};
