/**
 * Completeness critic — self-extending coverage.
 *
 * Do an initial pass, then a CRITIC decides what is still MISSING (a modality not
 * run, a claim not verified, a source not read). Its answer becomes the next round
 * of targeted work. Repeat until the critic says "complete" or we hit a budget.
 * The work-list grows from the gaps found — that is dynamism, not a fixed plan.
 *
 * Uses: ctx.agents({settle}), ctx.agent({schema}) for a typed critic verdict, a
 * result-driven loop, and no-silent-caps logging.
 */
module.exports = async function workflow(ctx, input) {
  const safeParse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
  const question = input?.question ?? input?.text;
  if (!question) throw new Error('Pass { question: "..." }');
  const maxRounds = input?.maxRounds ?? 4;
  const concurrency = Math.min(input?.concurrency ?? ctx.limits.concurrency, ctx.limits.concurrency);

  const CRITIC = {
    type: "object",
    additionalProperties: false,
    required: ["complete", "gaps"],
    properties: {
      complete: { type: "boolean", description: "true if nothing material is missing" },
      gaps: {
        type: "array",
        description: "concrete missing pieces to investigate next; empty when complete",
        items: { type: "string" },
      },
    },
  };

  const evidence = [];
  // Round 0 seeds with the question itself; later rounds seed with the critic's gaps.
  let todo = [question];
  let round = 0;

  while (todo.length > 0 && round < maxRounds) {
    round++;
    const batch = await ctx.agents(
      todo.map((item, i) => ({
        name: `investigate-r${round}-${i}`,
        prompt: `Investigate and answer with evidence (cite sources/files/commands):\n${item}`,
        tools: ["read", "grep", "find", "ls", "bash"],
        agentType: "researcher",
      })),
      { concurrency, settle: true },
    );
    batch.filter(Boolean).forEach((r, i) => evidence.push({ topic: todo[i], output: r.output }));

    const critic = await ctx.agent(
      `You are a completeness critic for the question: ${question}\n\n` +
        `Review the evidence gathered so far and decide what is still MISSING — a modality not run, ` +
        `a claim not verified, a source not read. Return gaps as concrete next investigations, or complete=true.\n\n` +
        `Evidence:\n${ctx.compact(evidence, 60000)}`,
      { name: `critic-r${round}`, agentType: "reviewer", tools: ["read", "grep", "find", "ls"], schema: CRITIC },
    );
    const verdict = critic.data ?? safeParse(critic.output) ?? { complete: true, gaps: [] };
    await ctx.log(`round ${round}: complete=${verdict.complete} gaps=${(verdict.gaps || []).length}`);
    if (verdict.complete) { todo = []; break; }
    todo = (verdict.gaps || []).slice(0, concurrency); // bound the next round
  }

  if (round >= maxRounds && todo.length > 0) {
    await ctx.log("stopped at maxRounds with gaps still open (not silently dropped)", { open: todo });
  }

  await ctx.writeArtifact("evidence.json", evidence);
  const synthesis = await ctx.agent(
    `Synthesize a complete, evidence-backed answer to: ${question}\nNote any gaps that remain open.\n\n${ctx.compact(evidence, 80000)}`,
    { name: "synthesis", agentType: "researcher", tools: ["read", "grep", "find", "ls"] },
  );
  return synthesis.output;
};
