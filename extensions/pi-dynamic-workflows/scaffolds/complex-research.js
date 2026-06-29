function chooseConcurrency(ctx, input, items, opts = {}) {
	if (Number.isFinite(input?.concurrency)) {
		return Math.min(Math.max(Math.floor(input.concurrency), 1), ctx.limits.concurrency, Math.max(1, items.length));
	}
	if (items.length <= 1) return 1;
	if (opts.usesWeb) return Math.min(3, items.length, ctx.limits.concurrency);
	if (items.length >= 8) return Math.min(6, items.length, ctx.limits.concurrency);
	return Math.min(4, items.length, ctx.limits.concurrency); // small/safe fallback, not a default ceiling
}

export default async function workflow(ctx, input) {
	const question = input?.question ?? input?.q ?? input?.text;
	if (!question) throw new Error('Pass { question: "..." } as workflow input.');

	const angles = input?.angles ?? [
		"official documentation and primary sources",
		"implementation options and tradeoffs",
		"risks, gotchas, and migration concerns",
		"best current recommendation with evidence",
	];
	const concurrency = chooseConcurrency(ctx, input, angles, { usesWeb: true });

	await ctx.log("Starting deep research", { question, angles, concurrency });

	const research = await ctx.agents(
		angles.map((angle, index) => ({
			name: `research-${String(angle).slice(0, 40)}`,
			prompt: `Research this question from the perspective of: ${angle}.

Question: ${question}

Pattern: independent research fan-out. This is branch ${index + 1}/${angles.length}. Your answer must be useful even if other agents fail.

Evidence rules:
- Prefer official docs, primary sources, repository evidence, and concrete observed behavior.
- Cite URLs, files/lines, or commands only if actually used/observed.
- Separate facts, interpretation, and open questions.
- If evidence is insufficient, say INSUFFICIENT_EVIDENCE and explain what would be needed.

Output format:
## Key findings
## Evidence / sources
## Tradeoffs
## Risks / gotchas
## Recommendation for this angle`,
			tools: ["read", "grep", "find", "ls", "web_search"],
			includeExtensions: true,
			agentType: "researcher",
			timeoutMs: input?.agentTimeoutMs ?? ctx.limits.agentTimeoutMs,
		})),
		{ concurrency, settle: true },
	);

	const completedResearch = research.filter(Boolean);
	const failed = research.length - completedResearch.length;
	await ctx.log("research fan-out complete", { total: research.length, completed: completedResearch.length, failed });
	await ctx.writeArtifact("research.json", research);

	const synthesis = await ctx.agent(
		`Synthesize this research into a final answer.

Pattern: synthesis-as-judge. Deduplicate, prefer primary evidence, mark uncertainty, and mention failed/empty research outputs.

Question: ${question}

Coverage:
- Angles requested: ${angles.length}
- Completed branches: ${completedResearch.length}
- Failed/empty branches: ${failed}

Output format:
1. Executive summary.
2. Recommendation.
3. Evidence/sources.
4. Tradeoffs and alternatives.
5. Risks/open questions.
6. Coverage gaps and what to verify next.

Research outputs:
${ctx.compact(
	completedResearch.map((r) => ({ name: r.name, output: r.output })),
	90000,
)}\n\nNow produce the output format above: executive summary first, prefer primary evidence, mark uncertainty, and explicitly note the ${failed} failed/empty branches.`,
		{
			name: "research-synthesis",
			tools: ["read", "grep", "find", "ls", "web_search"],
			includeExtensions: true,
			agentType: "researcher",
			timeoutMs: input?.agentTimeoutMs ?? ctx.limits.agentTimeoutMs,
		},
	);

	await ctx.writeArtifact("synthesis.md", synthesis.output);
	return synthesis.output;
}
