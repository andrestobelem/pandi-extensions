/**
 * Dynamic discovery — loop-until-dry.
 *
 * Depth is NOT fixed up front: keep fanning out finders until K consecutive
 * rounds surface nothing new. This is the hallmark of a *dynamic* workflow —
 * the shape adapts to what is found, instead of a static "map N items -> synth".
 *
 * Uses: ctx.agents({ settle:true }) (one crashed finder doesn't sink the round),
 * a dedupe Set keyed by a stable id, and ctx.log so the cap is never silent.
 */
module.exports = async function workflow(ctx, input) {
	const quietToStop = input?.quietRounds ?? 2;
	const maxRounds = input?.maxRounds ?? 8;
	const finders = input?.finders ?? 3;
	const seen = new Set();
	const all = [];
	let quiet = 0;
	let round = 0;

	while (quiet < quietToStop && round < maxRounds) {
		round++;
		const concurrency = Math.min(finders, ctx.limits.concurrency);
		const batches = await ctx.agents(
			Array.from({ length: finders }, (_unused, i) => ({
				name: `find-r${round}-a${i + 1}`,
				prompt:
					`Find NEW issues NOT already in the list below (dedupe by a short stable id). ` +
					`Look from angle #${i + 1} (use a different search strategy than the other finders). ` +
					`Return a JSON array of { id, title, evidence }; return [] if nothing new.\n\n` +
					`Already found:\n${ctx.compact(all, 4000)}`,
				tools: ["read", "grep", "find", "ls"],
				cache: false, // discovery must re-look each round, never serve a cached hit
			})),
			{ concurrency, settle: true },
		);

		let fresh = 0;
		for (const r of batches.filter(Boolean)) {
			let arr = [];
			try {
				arr = JSON.parse(r.output);
			} catch {
				/* tolerate non-JSON finders */
			}
			for (const item of Array.isArray(arr) ? arr : []) {
				if (item?.id && !seen.has(item.id)) {
					seen.add(item.id);
					all.push(item);
					fresh++;
				}
			}
		}
		await ctx.log(`round ${round}: +${fresh} new (${all.length} total)`, { quiet });
		quiet = fresh === 0 ? quiet + 1 : 0;
	}

	if (round >= maxRounds && quiet < quietToStop) {
		// No silent caps: say we stopped on the round budget, not because we ran dry.
		await ctx.log("stopped at maxRounds (not dry)", { maxRounds, total: all.length });
	}

	await ctx.writeArtifact("findings.json", all);
	const synthesis = await ctx.agent(
		`Synthesis-as-judge over every round. Deduplicate, drop unsupported claims, prioritize by severity, keep evidence.\n\n${ctx.compact(all, 60000)}\n\nNow produce the deduplicated, severity-ordered findings with evidence (most severe first), dropping unsupported claims.`,
		{ name: "synthesis", agentType: "reviewer", tools: ["read", "grep", "find", "ls"] },
	);
	return synthesis.output;
};
