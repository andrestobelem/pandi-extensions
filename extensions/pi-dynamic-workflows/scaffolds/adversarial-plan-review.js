function chooseConcurrency(ctx, input, items) {
	if (Number.isFinite(input?.concurrency)) {
		return Math.min(Math.max(Math.floor(input.concurrency), 1), ctx.limits.concurrency, Math.max(1, items.length));
	}
	return Math.min(4, items.length, ctx.limits.concurrency); // small/safe fallback for bounded reviewer panels
}

export default async function workflow(ctx, input) {
	const plan = input?.plan ?? input?.text;
	if (!plan) throw new Error('Pass { plan: "..." } as workflow input.');

	const sharedContract = `
Pattern: independent adversarial review. Do not edit files. Do not assume other reviewers will cover missing issues.
Evidence rules:
- Cite files/lines when the plan references repository code.
- Separate confirmed issues from speculative risks.
- Prefer actionable, high-signal feedback over generic warnings.
- If evidence is insufficient, say INSUFFICIENT_EVIDENCE.
Output format:
## Verdict
## Must-fix issues
## Should-fix issues
## Questions / missing evidence
## Smallest safe path`;

	const reviewers = [
		{
			name: "correctness-reviewer",
			angle: "correctness risks, missing edge cases, and invalid assumptions",
		},
		{
			name: "security-reviewer",
			angle: "security, privacy, permission, and data-loss risks",
		},
		{
			name: "maintainability-reviewer",
			angle: "maintainability, complexity, testability, and future migration concerns",
		},
		{
			name: "scope-reviewer",
			angle: "scope creep; what to remove, defer, or simplify while preserving the goal",
		},
	];

	const concurrency = chooseConcurrency(ctx, input, reviewers);
	await ctx.log("adversarial review fan-out selected", { reviewers: reviewers.length, concurrency });

	const critiques = await ctx.agents(
		reviewers.map((reviewer, index) => ({
			name: reviewer.name,
			prompt: `Review this implementation plan for ${reviewer.angle}.

This is independent reviewer ${index + 1}/${reviewers.length}. Your critique must be useful even if other reviewers fail.
${sharedContract}

Plan:
${plan}`,
			tools: ["read", "grep", "find", "ls"],
			agentType: "reviewer",
			timeoutMs: input?.agentTimeoutMs ?? ctx.limits.agentTimeoutMs,
		})),
		{
			concurrency,
			settle: true,
		},
	);

	const completedCritiques = critiques.filter(Boolean);
	const failed = critiques.length - completedCritiques.length;
	await ctx.log("adversarial review fan-out complete", {
		total: critiques.length,
		completed: completedCritiques.length,
		failed,
	});
	await ctx.writeArtifact("critiques.json", critiques);

	const synthesis = await ctx.agent(
		`Synthesize these critiques into a revised implementation plan.

Pattern: synthesis-as-judge. Deduplicate, resolve contradictions, discard unsupported claims unless marked speculative, and preserve accepted risks. Mention failed/empty reviewers explicitly.

Coverage:
- Reviewers requested: ${reviewers.length}
- Completed reviewers: ${completedCritiques.length}
- Failed/empty reviewers: ${failed}

Output format:
1. Revised plan in order.
2. Must-fix changes before implementation.
3. Optional/deferred changes.
4. Risks accepted and why.
5. Validation checklist.
6. Coverage gaps / failed reviewers.

Critiques:
${ctx.compact(
	completedCritiques.map((r) => ({ name: r.name, output: r.output })),
	60000,
)}\n\nNow produce the output format above: revised plan first, must-fix changes next, discard unsupported claims, and explicitly note the ${failed} failed/empty reviewers.`,
		{
			name: "plan-synthesis",
			tools: ["read", "grep", "find", "ls"],
			agentType: "planner",
			timeoutMs: input?.agentTimeoutMs ?? ctx.limits.agentTimeoutMs,
		},
	);

	await ctx.writeArtifact("revised-plan.md", synthesis.output);
	return synthesis.output;
}
