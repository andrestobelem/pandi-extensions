module.exports = async function workflow(ctx, input) {
  const plan = input?.plan ?? input?.text;
  if (!plan) throw new Error("Pass { plan: \"...\" } as workflow input.");

  const sharedContract = `
Pattern: independent adversarial review. Do not edit files. Do not assume other reviewers will cover missing issues.
Evidence rules:
- Cite files/lines when the plan references repository code.
- Separate confirmed issues from speculative risks.
- Prefer actionable, high-signal feedback over generic warnings.
Output format:
## Verdict
## Must-fix issues
## Should-fix issues
## Questions / missing evidence
## Smallest safe path`;

  const reviewers = [
    {
      name: "correctness-reviewer",
      prompt: `Review this implementation plan for correctness risks, missing edge cases, and invalid assumptions.
${sharedContract}

Plan:
${plan}`,
    },
    {
      name: "security-reviewer",
      prompt: `Review this implementation plan for security, privacy, permission, and data-loss risks.
${sharedContract}

Plan:
${plan}`,
    },
    {
      name: "maintainability-reviewer",
      prompt: `Review this implementation plan for maintainability, complexity, testability, and future migration concerns.
${sharedContract}

Plan:
${plan}`,
    },
    {
      name: "scope-reviewer",
      prompt: `Review this implementation plan for scope creep. Identify what to remove, defer, or simplify while preserving the goal.
${sharedContract}

Plan:
${plan}`,
    },
  ];

  const critiques = await ctx.agents(reviewers.map((reviewer) => ({
    ...reviewer,
    tools: ["read", "grep", "find", "ls"],
    timeoutMs: input?.agentTimeoutMs ?? ctx.limits.agentTimeoutMs,
  })), {
    concurrency: Math.min(input?.concurrency ?? 4, ctx.limits.concurrency),
  });

  await ctx.writeArtifact("critiques.json", critiques);

  const synthesis = await ctx.agent(
    `Synthesize these critiques into a revised implementation plan.

Pattern: synthesis-as-judge. Deduplicate, resolve contradictions, discard unsupported claims unless marked speculative, and preserve accepted risks.

Output format:
1. Revised plan in order.
2. Must-fix changes before implementation.
3. Optional/deferred changes.
4. Risks accepted and why.
5. Validation checklist.

Critiques:
${ctx.compact(critiques, 60000)}`,
    { name: "plan-synthesis", tools: ["read", "grep", "find", "ls"], timeoutMs: input?.agentTimeoutMs ?? ctx.limits.agentTimeoutMs },
  );

  await ctx.writeArtifact("revised-plan.md", synthesis.output);
  return synthesis.output;
};
