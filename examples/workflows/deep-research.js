module.exports = async function workflow(ctx, input) {
  const question = input?.question ?? input?.q ?? input?.text;
  if (!question) throw new Error("Pass { question: \"...\" } as workflow input.");

  const angles = input?.angles ?? [
    "official documentation and primary sources",
    "implementation options and tradeoffs",
    "risks, gotchas, and migration concerns",
    "best current recommendation with evidence",
  ];

  await ctx.log("Starting deep research", { question, angles });

  const research = await ctx.agents(
    angles.map((angle) => ({
      name: `research-${String(angle).slice(0, 40)}`,
      prompt: `Research this question from the perspective of: ${angle}.

Question: ${question}

Pattern: independent research fan-out. Your answer must be useful even if other agents fail.

Evidence rules:
- Prefer official docs, primary sources, and repository evidence.
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
      timeoutMs: input?.agentTimeoutMs ?? ctx.limits.agentTimeoutMs,
    })),
    { concurrency: Math.min(input?.concurrency ?? ctx.limits.concurrency, ctx.limits.concurrency) },
  );

  await ctx.writeArtifact("research.json", research);

  const synthesis = await ctx.agent(
    `Synthesize this research into a final answer.

Pattern: synthesis-as-judge. Deduplicate, prefer primary evidence, mark uncertainty, and mention failed/empty research outputs.

Question: ${question}

Output format:
1. Executive summary.
2. Recommendation.
3. Evidence/sources.
4. Tradeoffs and alternatives.
5. Risks/open questions.
6. What to verify next.

Research outputs:
${ctx.compact(research, 90000)}`,
    { name: "research-synthesis", tools: ["read", "grep", "find", "ls", "web_search"], includeExtensions: true, timeoutMs: input?.agentTimeoutMs ?? ctx.limits.agentTimeoutMs },
  );

  await ctx.writeArtifact("synthesis.md", synthesis.output);
  return synthesis.output;
};
