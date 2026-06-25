/**
 * Composition driver (ranking) — parent workflow that DISCOVERS candidates and
 * then delegates the reusable ranking phase to ctx.workflow("lib/rank-candidates").
 *
 * This is the second composition driver in the package. adaptive-composition-driver
 * delegates VERIFICATION (filter) to lib/verify-claims; this one delegates RANKING
 * (order) to lib/rank-candidates. Same shape, different reusable phase — the point
 * is that ctx.workflow() lets you build a library of composable phases (under lib/)
 * and wire them into different parents with no decision gate in between.
 *
 * Input:  { goal: "...", maxCandidates?: 6, jurors?: 3, keepTop?: <n> }
 * Output: a short synthesis string; writes candidates.json / ranking.json / best.md
 *
 * HOW TO RUN (resolution): ctx.workflow() resolves names from the runtime workflow
 * directory (.pi/workflows or global ~/.pi/agent/workflows), NOT from examples/.
 * Copy both files preserving the lib/ path, then run the driver:
 *
 *   mkdir -p .pi/workflows/lib
 *   cp examples/workflows/lib/rank-candidates.js     .pi/workflows/lib/
 *   cp examples/workflows/composition-rank-driver.js .pi/workflows/
 *   pi   # then: /dynamic-workflow run composition-rank-driver '{"goal":"name a CLI"}'
 *
 * See examples/e2e/composition-rank.e2e.mjs for a runnable proof that this exact
 * layout resolves against the real extension (parent -> lib/rank-candidates).
 */
module.exports = async function workflow(ctx, input) {
  const goal = input?.goal ?? input?.topic ?? input?.question ?? input?.text;
  if (!goal) throw new Error('Pass { goal: "what to generate and rank candidates for" }.');
  const maxCandidates = Math.max(2, Number(input?.maxCandidates ?? 6));

  // 1) DISCOVER: generate candidate options for the goal (this is the non-reusable,
  //    goal-specific part that stays in the parent).
  const generator = await ctx.agent(
    `Generate up to ${maxCandidates} distinct, concrete candidate options for the goal below. ` +
      `Return ONLY a JSON array of { id, text }. Make the options genuinely different from each other.\n\n` +
      `Goal: ${goal}`,
    { name: "candidate-generator", agentType: "researcher", tools: ["read", "grep", "find", "ls"] },
  );

  let candidates = [];
  try {
    candidates = JSON.parse(generator.output);
  } catch {
    candidates = [];
  }
  candidates = Array.isArray(candidates)
    ? candidates.filter((cand) => cand && typeof cand.text === "string").slice(0, maxCandidates)
    : [];
  if (candidates.length === 0) return "No candidate options were generated to rank.";
  if (candidates.length >= maxCandidates) await ctx.log("candidate cap applied", { generated: candidates.length, maxCandidates });
  await ctx.writeArtifact("candidates.json", candidates);

  // 2) DELEGATE the reusable ranking phase to the lib/ sub-workflow.
  //    No human/decision gate sits between discovery and ranking, so composition
  //    (not a separate run) is the right tool: shared run, budget, and cache.
  const ranking = await ctx.workflow("lib/rank-candidates", {
    candidates,
    goal,
    rubric: input?.rubric,
    jurors: input?.jurors ?? 3,
    keepTop: input?.keepTop,
  });
  await ctx.writeArtifact("ranking.json", ranking);

  if (!ranking.best) return "Ranking produced no scorable candidate.";

  // 3) SYNTHESIZE: explain the winner using the delegated ranking.
  const synthesis = await ctx.agent(
    `Explain why the top-ranked candidate won and how it compares to the runners-up. ` +
      `Cite the juror scores. Note that ranking was delegated to lib/rank-candidates.\n\n` +
      `${ctx.compact(ranking, 50000)}`,
    { name: "rank-synthesis", agentType: "reviewer", tools: ["read", "grep", "find", "ls"] },
  );
  await ctx.writeArtifact("best.md", synthesis.output);
  return synthesis.output;
};
