/**
 * Generate -> judge -> ADAPTIVE escalate (best-of-N that deepens only when unsure).
 *
 * Generates candidates from distinct angles and judges them with a typed verdict.
 * The dynamism: if the judge is NOT confident, spend more — another, more rigorous
 * round of candidates — instead of committing to a weak winner. Confident => stop.
 *
 * Uses: ctx.parallel([thunks]) (barrier: judge all together),
 * ctx.agent({ schema }) for a structured verdict, a result-driven while loop.
 */
export default async function workflow(ctx, input) {
	const safeParse = (s) => {
		try {
			return JSON.parse(s);
		} catch {
			return undefined;
		}
	};
	const question = input?.question ?? input?.q ?? input?.text;
	if (!question) throw new Error('Pass { question: "..." } as workflow input.');
	const angles = input?.angles ?? ["risk-first", "simplicity-first", "user-first"];
	const maxEscalations = Number.isFinite(+input?.maxEscalations) ? Math.floor(+input.maxEscalations) : 2;

	const VERDICT = {
		type: "object",
		additionalProperties: false,
		required: ["winner", "confidence", "why"],
		properties: {
			winner: { type: "number", description: "1-based index of the best candidate" },
			confidence: { type: "string", description: "one of: high | medium | low" },
			why: { type: "string" },
		},
	};

	const candidates = [];
	let escalation = 0;
	let verdict;

	while (true) {
		const tougher =
			escalation > 0
				? " Be more rigorous than a basic answer; pre-empt the weaknesses a skeptical critic would raise."
				: "";
		const batch = await ctx.parallel(
			angles.map(
				(angle, i) => () =>
					ctx.agent(
						`Propose an approach to the question below.\nAngle: ${angle}.${tougher}\n\nQuestion: ${question}`,
						{
							name: `cand-e${escalation}-${i}`,
							agentType: "researcher",
							tools: ["read", "grep", "find", "ls", "bash"],
						},
					),
			),
		);
		// Index by the ORIGINAL angle position, skipping nulls — never filter-then-index,
		// or a crashed branch shifts every later survivor's angle label.
		batch.forEach((r, i) => {
			if (r) candidates.push({ angle: angles[i], text: r.output });
		});

		const j = await ctx.agent(
			`You are the judge. Pick the single best candidate for the question. Be skeptical and demand evidence.\n\n` +
				`Question: ${question}\n\n` +
				candidates.map((c, i) => `### Candidate ${i + 1} (${c.angle})\n${c.text}`).join("\n\n"),
			{
				name: `judge-e${escalation}`,
				agentType: "reviewer",
				tools: ["read", "grep", "find", "ls"],
				schema: VERDICT,
			},
		);
		verdict = j.data ?? safeParse(j.output);
		await ctx.log(`escalation ${escalation}: winner=${verdict?.winner} confidence=${verdict?.confidence}`);

		// ADAPTIVE: stop when confident or out of budget; otherwise escalate with more candidates.
		if (verdict?.confidence === "high" || escalation >= maxEscalations) break;
		escalation++;
	}

	await ctx.writeArtifact("candidates.json", { candidates, verdict });
	const winner = candidates[(verdict?.winner ?? 1) - 1] ?? candidates[0];
	const synthesis = await ctx.agent(
		`Write the final answer to: ${question}\n\nBuild on the winning approach, grafting the best ideas from the runners-up; flag residual risks.\n\n` +
			`WINNER (${winner?.angle}):\n${winner?.text}\n\nALL CANDIDATES:\n${ctx.compact(candidates, 40000)}\n\nNow write the final answer to: ${question} — build on the winning approach, graft the best runner-up ideas, and flag residual risks.`,
		{ name: "synthesis", agentType: "researcher", tools: ["read", "grep", "find", "ls", "bash"] },
	);
	return synthesis.output;
}
