/**
 * Pi Dynamic Workflow
 *
 * Export a function: async function workflow(ctx, input) { ... }
 *
 * Pattern defaults:
 * - Scout first, then choose fan-out dynamically from the discovered work-list.
 * - Raise concurrency/maxAgents for many independent, read-only, low-risk items; keep them low for side effects, expensive models, shared-state edits, rate limits, or sequential dependencies.
 * - Decide model + thinking per call: cheap/fast model + low thinking for wide scouts/classification; stronger model + high/xhigh thinking for synthesis, verification, and hard reasoning. Pass { model, provider, thinking } on agent/agents/pipeline/specs.
 * - Log the selected concurrency/maxAgents and any ctx.limits clamp so caps are visible.
 * - Use evidence contracts and synthesis-as-judge; do not summarize unsupported claims.
 * - Subagents get web_search via pi-codex-web-search and context7-cli when installed; do not opt out unless isolation is required.
 * - Log caps and partial failures; never hide skipped work.
 *
 * Useful ctx helpers:
 * - ctx.agent(prompt, opts)        Run one Pi subagent; opts can include model, provider, thinking (off|minimal|low|medium|high|xhigh), tools, skills, extensions, keys, schema, or agentType
 * - ctx.agents([...], opts)        Run many subagents with bounded concurrency; add {settle:true} for null-on-failure
 * - ctx.pipeline(items, ...stages) Multi-stage per-item flow without global barriers; failed items return null
 * - ctx.parallel([...thunks])      Run async branches with a barrier; failed branches return null
 * - ctx.workflow(name, input)      Compose a reusable sub-workflow inline (depth 1, shared run budget/cache)
 * - ctx.bash(command, opts)        Run a shell command
 * - ctx.readFile/writeFile(...)    File helpers relative to the project cwd
 * - ctx.writeArtifact(name, data)  Persist intermediate state under ctx.runDir
 * - ctx.log(message, details)      Stream progress to Pi and events.jsonl
 */

function chooseConcurrency(ctx, input, items, opts = {}) {
	if (Number.isFinite(input?.concurrency)) {
		return Math.min(Math.max(Math.floor(input.concurrency), 1), ctx.limits.concurrency, Math.max(1, items.length));
	}
	if (items.length <= 1) return 1;
	if (opts.sideEffects || opts.expensiveModel || opts.sharedState)
		return Math.min(2, items.length, ctx.limits.concurrency);
	if (opts.readOnlyAudit && items.length >= 50) return Math.min(12, items.length, ctx.limits.concurrency);
	if (opts.readOnlyAudit && items.length >= 20) return Math.min(8, items.length, ctx.limits.concurrency);
	if (items.length >= 8 && !opts.expensiveModel) return Math.min(6, items.length, ctx.limits.concurrency);
	return Math.min(4, items.length, ctx.limits.concurrency); // small/safe fallback, not a default ceiling
}

module.exports = async function workflow(ctx, input) {
	await ctx.log("Starting workflow", { input });

	const files = await ctx.bash("git ls-files", { throwOnError: true });
	const allCandidates = files.stdout
		.split("\n")
		.filter(Boolean)
		.filter((file) => /\.(ts|tsx|js|jsx|py|go|rs)$/.test(file));
	const limit = input?.limit ?? 12;
	const candidates = allCandidates.slice(0, limit);
	if (candidates.length < allCandidates.length) {
		await ctx.log("candidate cap applied", {
			reviewed: candidates.length,
			total: allCandidates.length,
			skipped: allCandidates.length - candidates.length,
		});
	}
	await ctx.writeArtifact("candidate-files.json", candidates);

	const concurrency = chooseConcurrency(ctx, input, candidates, { readOnlyAudit: true });
	await ctx.log("fan-out selected", { items: candidates.length, concurrency, maxAgents: ctx.limits.maxAgents });

	// Per-call model/thinking: wide scouts can run cheaper + lower thinking; the
	// synthesis below runs higher thinking. Uncomment `model` to pin a model id.
	const reviews = await ctx.agents(
		candidates.map((file, index) => ({
			name: `review-${file}`,
			prompt: `Review ${file} for likely bugs or risky code. This is branch ${index + 1}/${candidates.length}; your report must be useful even if other branches fail. Cite file/line evidence for every finding. Say NO_FINDINGS if there are no credible issues.`,
			tools: ["read", "grep", "find", "ls"],
			agentType: "reviewer",
			// model: "haiku", // optional: a cheaper/faster model for wide scouting
			thinking: "low", // cheap per-file pass; explicit thinking overrides the persona default
		})),
		{ concurrency, settle: true },
	);
	const completedReviews = reviews.filter(Boolean);
	await ctx.log("fan-out complete", {
		total: reviews.length,
		completed: completedReviews.length,
		failed: reviews.length - completedReviews.length,
	});

	await ctx.writeArtifact("reviews.json", reviews);

	const synthesis = await ctx.agent(
		`Synthesize these review outputs into prioritized findings. Pattern: synthesis-as-judge. Discard unsupported claims; mention caps and failed branches.\n\nCoverage: ${candidates.length}/${allCandidates.length} files, failed branches: ${reviews.length - completedReviews.length}\n\n${ctx.compact(
			completedReviews.map((r) => ({ name: r.name, output: r.output })),
			50000,
		)}\n\nNow do exactly that: prioritized findings, most severe first, discard unsupported claims, and explicitly note the ${reviews.length - completedReviews.length} failed branch(es).`,
		// Stronger reasoning for the judge step; pin a model with `model` if you want.
		{ name: "synthesis", tools: ["read", "grep", "find", "ls"], agentType: "reviewer", thinking: "high" },
	);

	await ctx.writeArtifact("summary.md", synthesis.output);
	return synthesis.output;
};
