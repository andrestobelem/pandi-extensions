module.exports = async function workflow(ctx, input) {
	const raw = Array.isArray(input?.candidates) ? input.candidates : [];
	const candidates = raw
		.map((cand, i) => (typeof cand === "string" ? { id: `cand-${i}`, text: cand } : cand))
		.filter((cand) => cand && typeof cand.text === "string" && cand.text.trim().length > 0)
		.map((cand, i) => ({ id: cand.id ?? `cand-${i}`, text: cand.text }));
	const dropped = raw
		.map((cand, i) => ({ cand, i }))
		.filter(
			({ cand }) =>
				!cand ||
				typeof (typeof cand === "string" ? cand : cand.text) !== "string" ||
				String(typeof cand === "string" ? cand : cand.text).trim().length === 0,
		)
		.map(({ cand, i }) => ({
			id: (cand && cand.id) ?? `cand-${i}`,
			text: cand && cand.text,
			reason: "empty or non-text candidate",
		}));

	if (candidates.length === 0) {
		const empty = { ranked: [], best: null, dropped, coverage: { candidates: 0, jurors: 0, requestedJurors: 0 } };
		await ctx.writeArtifact("rank-candidates-result.json", empty);
		return empty;
	}

	const requestedJurors = Math.max(1, Number(input?.jurors ?? 3));
	// Never spawn more parallel agents than the run's concurrency budget allows.
	const jurors = Math.min(requestedJurors, ctx.limits.concurrency);
	if (jurors < requestedJurors) {
		await ctx.log("juror cap applied", {
			requested: requestedJurors,
			running: jurors,
			concurrency: ctx.limits.concurrency,
		});
	}

	const rubric = input?.rubric ?? "overall quality, clarity, and fitness for the stated goal";
	const goal = input?.goal ?? "n/a";

	const SCORE = {
		type: "object",
		additionalProperties: false,
		required: ["score", "rationale"],
		properties: {
			score: { type: "number", description: "0-10, higher is better" },
			rationale: { type: "string", description: "one short sentence justifying the score" },
		},
	};

	const ranked = [];
	for (let i = 0; i < candidates.length; i++) {
		const candidate = candidates[i];
		// Independent jury: each juror scores the candidate against the rubric.
		// settle:true so one juror erroring/timing-out does not abort the rest.
		const jury = await ctx.agents(
			Array.from({ length: jurors }, (_unused, j) => ({
				name: `rank-${candidate.id}-juror-${j + 1}`,
				prompt:
					`You are juror ${j + 1}/${jurors}. Score the candidate below from 0 to 10 against the rubric. ` +
					`Be calibrated: reserve 9-10 for clearly excellent, 0-3 for clearly poor.\n\n` +
					`Goal: ${goal}\n` +
					`Rubric: ${rubric}\n` +
					`Candidate: ${candidate.text}\n\n` +
					`Return JSON only matching the schema.`,
				agentType: "reviewer",
				tools: ["read", "grep", "find", "ls"],
				schema: SCORE,
				schemaOnInvalid: "null",
			})),
			{ concurrency: jurors, settle: true },
		);
		const parsed = jury
			.filter(Boolean)
			.map((result) => result.data)
			.filter((vote) => vote && typeof vote.score === "number" && Number.isFinite(vote.score));
		if (parsed.length === 0) {
			dropped.push({ id: candidate.id, text: candidate.text, reason: "no juror returned a valid score" });
			await ctx.log("candidate unscorable", { id: candidate.id, failedBranches: jury.length });
			continue;
		}
		// Average juror score; clamp into [0,10] so a stray out-of-range vote cannot dominate.
		const clamped = parsed.map((vote) => Math.min(10, Math.max(0, vote.score)));
		const score = clamped.reduce((acc, value) => acc + value, 0) / clamped.length;
		const rationale = parsed
			.map((vote) => vote.rationale)
			.filter(Boolean)
			.join(" | ");
		ranked.push({ id: candidate.id, text: candidate.text, score, votes: clamped, rationale });
		await ctx.log("candidate scored", {
			id: candidate.id,
			score,
			jurors: clamped.length,
			failedBranches: jury.length - parsed.length,
		});
	}

	// Deterministic best-first order; tie-break by id so the ranking is stable.
	ranked.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));

	const keepTop = Number(input?.keepTop);
	const finalRanked = Number.isFinite(keepTop) && keepTop > 0 ? ranked.slice(0, keepTop) : ranked;

	// `best` is a SHALLOW COPY of the top entry, not the same object reference, so
	// serialization (writeArtifact / ctx.compact) does not emit "[Circular]" for the
	// second occurrence of the shared object.
	const result = {
		ranked: finalRanked,
		best: finalRanked[0] ? { ...finalRanked[0] } : null,
		dropped,
		coverage: { candidates: candidates.length, jurors, requestedJurors },
	};
	await ctx.writeArtifact("rank-candidates-result.json", result);
	await ctx.log("ranking complete", {
		ranked: finalRanked.length,
		dropped: dropped.length,
		best: result.best?.id ?? null,
	});
	return result;
};
