/**
 * Tree of Thoughts / beam search — score-pruned deliberate search.
 *
 * Generate K candidate "thoughts" for the problem, SCORE each with a typed judge
 * ({ score, why }), keep the top-M (the beam), then expand only the survivors into
 * K children, and repeat for D levels. Return the best root-to-leaf path.
 * The dynamism: the frontier is rebuilt every level from the highest-scoring nodes,
 * so the search beam follows the best partial reasoning instead of a fixed plan —
 * weak branches are pruned and never expanded.
 *
 * Uses: ctx.agents({settle}) to expand the whole frontier in parallel,
 * ctx.parallel([thunks]) to score the level as a barrier, ctx.agent({schema}) for a
 * typed score, and no-silent-caps logging for the beam/branch bounds.
 */
module.exports = async function workflow(ctx, input) {
  const safeParse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
  const problem = input?.problem ?? input?.question ?? input?.text;
  if (!problem) throw new Error('Pass { problem: "..." } as workflow input.');

  const concurrency = Math.min(input?.concurrency ?? ctx.limits.concurrency, ctx.limits.concurrency);
  const branching = Math.max(1, input?.branching ?? 3); // K children per node
  const beamWidth = Math.max(1, input?.beamWidth ?? 2);  // M survivors per level
  const depth = Math.max(1, input?.depth ?? 3);          // D levels deep

  const SCORE = {
    type: "object",
    additionalProperties: false,
    required: ["score", "why"],
    properties: {
      score: { type: "number", description: "0-100; how promising this reasoning step is toward solving the problem" },
      why: { type: "string", description: "one line justifying the score" },
    },
  };

  // A node: { id, level, parentId, thought, path:[thoughts...], score, why }
  const all = [];
  let nodeSeq = 0;
  const mkId = (level, i) => `L${level}N${i}_${nodeSeq++}`; // stable + unique => no cache collisions

  // Level 0: the root frontier is the problem itself (one virtual parent).
  let frontier = [{ id: "root", level: 0, parentId: null, thought: null, path: [], score: 100, why: "root" }];

  for (let level = 1; level <= depth; level++) {
    // EXPAND every survivor into K children, all in parallel.
    const expandJobs = [];
    frontier.forEach((parent) => {
      const ctxPath = parent.path.length
        ? `\n\nReasoning so far (build on it, do not repeat):\n${parent.path.map((t, k) => `${k + 1}. ${t}`).join("\n")}`
        : "";
      for (let k = 0; k < branching; k++) {
        const id = mkId(level, expandJobs.length);
        expandJobs.push({
          id,
          parent,
          prompt:
            `Problem: ${problem}${ctxPath}\n\n` +
            `Propose ONE distinct next reasoning step (branch #${k + 1} of ${branching}, level ${level}/${depth}, node ${id}). ` +
            `Make it materially different from sibling branches. Be concrete and self-contained.`,
        });
      }
    });

    const expanded = await ctx.agents(
      expandJobs.map((j) => ({
        name: `expand-${j.id}`,
        prompt: j.prompt,
        tools: ["read", "grep", "find", "ls", "bash"],
        agentType: "researcher",
      })),
      { concurrency, settle: true },
    );

    let children = expanded
      .map((r, i) => (r && r.ok !== false ? { job: expandJobs[i], thought: r.output } : null))
      .filter(Boolean)
      .map(({ job, thought }) => ({
        id: job.id,
        level,
        parentId: job.parent.id,
        thought,
        path: [...job.parent.path, thought],
        score: 0,
        why: "",
      }));

    if (children.length === 0) {
      await ctx.log(`level ${level}: no children produced; stopping early`, { frontier: frontier.length });
      break;
    }

    // SCORE the whole level as a barrier (parallel), so pruning sees every sibling.
    const scores = await ctx.parallel(
      children.map((c) => () =>
        ctx.agent(
          `Score this candidate reasoning step for the problem on a 0-100 scale.\n\n` +
            `Problem: ${problem}\n\nReasoning path (node ${c.id}):\n` +
            c.path.map((t, k) => `${k + 1}. ${t}`).join("\n"),
          { name: `score-${c.id}`, agentType: "reviewer", tools: ["read", "grep", "find", "ls"], schema: SCORE },
        ),
      ),
    );
    children.forEach((c, i) => {
      const v = scores[i] ? (scores[i].data ?? safeParse(scores[i].output)) : undefined;
      c.score = typeof v?.score === "number" ? v.score : 0;
      c.why = v?.why ?? "(unscored)";
    });

    all.push(...children);

    // PRUNE: keep top-M by score. The beam is rebuilt from results => dynamic frontier.
    const ranked = [...children].sort((a, b) => b.score - a.score);
    frontier = ranked.slice(0, beamWidth);
    await ctx.log(
      `level ${level}: expanded ${children.length} -> kept beam ${frontier.length}/${beamWidth} ` +
        `(branching=${branching}, depth=${depth})`,
      { kept: frontier.map((n) => ({ id: n.id, score: n.score })), pruned: ranked.length - frontier.length },
    );
  }

  // Best leaf overall = highest-scored node (deepest ties broken by level then score).
  const best =
    all.slice().sort((a, b) => b.score - a.score || b.level - a.level)[0] ??
    { path: [], score: 0, level: 0, id: "root" };

  await ctx.writeArtifact("tree.json", { problem, params: { branching, beamWidth, depth }, nodes: all, best });

  if (best.path.length === 0) {
    return "Tree of Thoughts produced no usable branches for the problem.";
  }

  // Synthesize the answer from the winning root-to-leaf path.
  const synthesis = await ctx.agent(
    `Solve the problem by following the winning line of reasoning below. Produce the final answer; ` +
      `note any assumptions or residual risks.\n\n` +
      `Problem: ${problem}\n\nWinning path (best score=${best.score}, node ${best.id}):\n` +
      best.path.map((t, k) => `Step ${k + 1}: ${t}`).join("\n\n"),
    { name: "synthesis", agentType: "researcher", tools: ["read", "grep", "find", "ls", "bash"] },
  );
  return synthesis.output;
};
