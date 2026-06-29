/**
 * TOURNAMENT / single-elimination bracket — pairwise judging until one survives.
 *
 * Candidates come from input.candidates, or are generated from distinct angles.
 * Each round pairs survivors and a judge picks the better of every pair
 * (typed verdict { winner:1|2, why }); winners advance, repeat until one remains.
 *
 * The dynamism: NOTHING about the shape is fixed up front. The number of rounds
 * is ceil(log2(n)) and emerges from the data — the bracket halves every round and
 * the loop ends when the field collapses to a single survivor. An odd field gives
 * one candidate a free "bye" into the next round (no fabricated opponent).
 *
 * Uses: ctx.agents({ settle:true }) so a crashed match never sinks the whole round,
 * ctx.agent({ schema }) for structured pairwise verdicts, ctx.log so the bracket
 * size / byes / round count are never a silent cap.
 */
module.exports = async function workflow(ctx, input) {
	const safeParse = (s) => {
		try {
			return JSON.parse(s);
		} catch {
			return undefined;
		}
	};
	const topic = input?.topic ?? input?.question ?? input?.q ?? input?.text;

	// Seed the bracket: explicit candidates win; otherwise generate one per angle.
	let entrants = Array.isArray(input?.candidates) ? input.candidates.filter(Boolean) : null;
	if (!entrants || entrants.length === 0) {
		if (!topic) throw new Error('Pass { candidates:[...] } or { topic:"..." } as workflow input.');
		const angles = input?.angles ?? ["risk-first", "simplicity-first", "user-first", "cost-first"];
		const gen = await ctx.agents(
			angles.map((angle, i) => ({
				name: `seed-${i}`,
				prompt: `Propose ONE concrete approach to the topic below.\nAngle: ${angle}.\n\nTopic: ${topic}`,
				agentType: "researcher",
				tools: ["read", "grep", "find", "ls", "bash"],
			})),
			{ concurrency: Math.min(angles.length, ctx.limits.concurrency), settle: true },
		);
		// Map BEFORE filtering so each entrant keeps the angle label at its original
		// index — a crashed seed (null) must not shift the labels of later entrants.
		entrants = gen.map((r, i) => (r ? `[${angles[i] ?? `angle-${i}`}] ${r.output}` : null)).filter(Boolean);
	}
	if (entrants.length < 2) {
		await ctx.log("only one entrant — no tournament needed", { entrants: entrants.length });
		return entrants[0] ?? "";
	}

	const VERDICT = {
		type: "object",
		additionalProperties: false,
		required: ["winner", "why"],
		properties: {
			winner: { type: "number", description: "1 if the first candidate is better, 2 if the second" },
			why: { type: "string" },
		},
	};

	const totalRounds = Math.ceil(Math.log2(entrants.length));
	await ctx.log(`tournament start: ${entrants.length} entrants -> ~${totalRounds} rounds`);

	// BRACKET: each iteration halves the field; loop ends when one survivor remains.
	let survivors = entrants.map((text, i) => ({ id: `e${i}`, text }));
	let round = 0;
	const transcript = [];

	while (survivors.length > 1) {
		round++;
		// Pair up survivors; an odd field gives the last one a bye (advances for free).
		const pairs = [];
		let bye = null;
		for (let i = 0; i < survivors.length; i += 2) {
			if (i + 1 < survivors.length) pairs.push([survivors[i], survivors[i + 1]]);
			else bye = survivors[i];
		}
		await ctx.log(
			`round ${round}/${totalRounds}: ${survivors.length} in, ${pairs.length} matches${bye ? " + 1 bye" : ""}`,
			{
				byeId: bye?.id ?? null,
			},
		);

		const matches = await ctx.agents(
			pairs.map(([a, b], i) => ({
				// Stable id (round + match) keeps the per-prompt cache from colliding across rounds.
				name: `match-r${round}-m${i}`,
				prompt:
					`You are the judge of a single match. Pick the BETTER candidate for the goal` +
					(topic ? ` (topic: ${topic})` : "") +
					`. Be skeptical and demand substance over polish.\n\n` +
					`### Candidate 1\n${a.text}\n\n### Candidate 2\n${b.text}`,
				agentType: "reviewer",
				tools: ["read", "grep", "find", "ls"],
				schema: VERDICT,
			})),
			{ concurrency: Math.min(Math.max(pairs.length, 1), ctx.limits.concurrency), settle: true },
		);

		const next = [];
		matches.forEach((r, i) => {
			const [a, b] = pairs[i];
			const v = r ? (r.data ?? safeParse(r.output)) : undefined;
			// Tolerate a crashed/invalid match: default to candidate 1 rather than dropping both.
			const winner = v?.winner === 2 ? b : a;
			transcript.push({
				round,
				match: i,
				a: a.id,
				b: b.id,
				winner: winner.id,
				why: v?.why ?? "(default: judge unavailable)",
			});
			next.push(winner);
		});
		if (bye) next.push(bye);
		survivors = next;
	}

	const champion = survivors[0];
	await ctx.log(`champion after ${round} rounds: ${champion?.id}`);
	await ctx.writeArtifact("tournament.json", {
		entrants: entrants.length,
		rounds: round,
		transcript,
		championId: champion?.id,
	});

	return champion?.text ?? "";
};
