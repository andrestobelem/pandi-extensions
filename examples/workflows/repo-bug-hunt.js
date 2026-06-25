module.exports = async function workflow(ctx, input) {
  const maxFiles = input?.maxFiles ?? 40;
  const concurrency = Math.min(input?.concurrency ?? ctx.limits.concurrency, ctx.limits.concurrency);

  await ctx.log("Collecting candidate files", { maxFiles });
  const filesResult = await ctx.bash(
    "git ls-files | grep -E '\\.(ts|tsx|js|jsx|py|go|rs)$' | head -" + Number(maxFiles),
    { throwOnError: true },
  );
  const files = filesResult.stdout.split("\n").filter(Boolean);
  await ctx.writeArtifact("candidate-files.json", files);

  const reviews = await ctx.agents(
    files.map((file) => ({
      name: `bug-hunt-${file}`,
      prompt: `Inspect ${file} for likely bugs, race conditions, security issues, data-loss risks, or edge-case failures.

Pattern: parallel file-level bug hunt. Be skeptical but evidence-based. Do not edit files.

Evidence rules:
- Cite file and line numbers for every finding.
- Explain the failing scenario, impact, and minimal fix.
- Ignore pure style unless it can cause a real failure.
- If there are no credible findings, say NO_FINDINGS.

Output format:
## Findings
- Severity High/Medium/Low | Confidence High/Medium/Low | Evidence | Scenario | Fix
## Non-findings / notes`,
      tools: ["read", "grep", "find", "ls"],
      timeoutMs: input?.agentTimeoutMs ?? ctx.limits.agentTimeoutMs,
    })),
    { concurrency },
  );

  await ctx.writeArtifact("reviews.json", reviews);

  const synthesis = await ctx.agent(
    `You are the final reviewer.

Pattern: synthesis-as-judge. Deduplicate and prioritize findings. Only include credible, actionable issues with evidence. Discard uncited concrete claims.

Output format:
1. Executive verdict.
2. Prioritized findings table: severity | confidence | file/line | issue | scenario | fix.
3. Findings rejected as low-confidence.
4. Suggested verification/tests.

Reviews:
${ctx.compact(reviews, 80000)}`,
    { name: "synthesis", tools: ["read", "grep", "find", "ls"], timeoutMs: input?.agentTimeoutMs ?? ctx.limits.agentTimeoutMs },
  );

  await ctx.writeArtifact("summary.md", synthesis.output);
  return synthesis.output;
};
