function chooseConcurrency(ctx, input, items, opts = {}) {
	if (Number.isFinite(input?.concurrency)) {
		return Math.min(Math.max(Math.floor(input.concurrency), 1), ctx.limits.concurrency, Math.max(1, items.length));
	}
	if (items.length <= 1) return 1;
	if (opts.expensiveModel || opts.sharedState) return Math.min(2, items.length, ctx.limits.concurrency);
	if (opts.readOnlyAudit && items.length >= 50) return Math.min(12, items.length, ctx.limits.concurrency);
	if (opts.readOnlyAudit && items.length >= 20) return Math.min(8, items.length, ctx.limits.concurrency);
	if (items.length >= 8 && !opts.expensiveModel) return Math.min(6, items.length, ctx.limits.concurrency);
	return Math.min(4, items.length, ctx.limits.concurrency); // small/safe fallback, not a default ceiling
}

export default async function workflow(ctx, input) {
	const maxFiles = input?.maxFiles ?? 40;

	await ctx.log("Collecting candidate files", { maxFiles });
	const filesResult = await ctx.bash("git ls-files | grep -E '\\.(ts|tsx|js|jsx|py|go|rs)$'", { throwOnError: true });
	const allFiles = filesResult.stdout.split("\n").filter(Boolean);
	const files = allFiles.slice(0, Number(maxFiles));
	if (files.length < allFiles.length) {
		await ctx.log("candidate file cap applied", {
			reviewed: files.length,
			total: allFiles.length,
			skipped: allFiles.length - files.length,
		});
	}
	await ctx.writeArtifact("candidate-files.json", files);

	const concurrency = chooseConcurrency(ctx, input, files, { readOnlyAudit: true });
	await ctx.log("bug-hunt fan-out selected", { files: files.length, concurrency, maxAgents: ctx.limits.maxAgents });

	const reviews = await ctx.agents(
		files.map((file, index) => ({
			name: `bug-hunt-${file}`,
			prompt: `Inspect ${file} for likely bugs, race conditions, security issues, data-loss risks, or edge-case failures.

Pattern: independent file-level bug hunt. This is branch ${index + 1}/${files.length}. Your report must be useful even if other branches fail. Be skeptical but evidence-based. Do not edit files.

Evidence rules:
- Cite file and line numbers for every finding.
- Explain the failing scenario, impact, and minimal fix.
- Ignore pure style unless it can cause a real failure.
- If there are no credible findings, say NO_FINDINGS.
- If evidence is insufficient, say INSUFFICIENT_EVIDENCE and explain what would be needed.

Output format:
## Verdict
## Findings
- Severity High/Medium/Low | Confidence High/Medium/Low | Evidence | Scenario | Fix
## Non-findings / notes`,
			tools: ["read", "grep", "find", "ls"],
			agentType: "reviewer",
			timeoutMs: input?.agentTimeoutMs ?? ctx.limits.agentTimeoutMs,
		})),
		{ concurrency, settle: true },
	);

	const completedReviews = reviews.filter(Boolean);
	const failed = reviews.length - completedReviews.length;
	await ctx.log("bug-hunt fan-out complete", { total: reviews.length, completed: completedReviews.length, failed });
	await ctx.writeArtifact("reviews.json", reviews);

	const synthesis = await ctx.agent(
		`You are the final reviewer.

Pattern: synthesis-as-judge. Deduplicate and prioritize findings. Only include credible, actionable issues with evidence. Discard uncited concrete claims. Mention partial failures and coverage caps explicitly.

Coverage:
- Reviewed files: ${files.length}/${allFiles.length}
- Failed/empty branches: ${failed}

Output format:
1. Executive verdict.
2. Prioritized findings table: severity | confidence | file/line | issue | scenario | fix.
3. Findings rejected as low-confidence or unsupported.
4. Coverage gaps / failed branches.
5. Suggested verification/tests.

Reviews:
${ctx.compact(
	completedReviews.map((r) => ({ name: r.name, output: r.output })),
	80000,
)}\n\nNow produce the output format above: executive verdict first, most severe findings first, discard uncited claims, and explicitly note the ${failed} failed/empty branches.`,
		{
			name: "synthesis",
			tools: ["read", "grep", "find", "ls"],
			agentType: "reviewer",
			timeoutMs: input?.agentTimeoutMs ?? ctx.limits.agentTimeoutMs,
		},
	);

	await ctx.writeArtifact("summary.md", synthesis.output);
	return synthesis.output;
}
