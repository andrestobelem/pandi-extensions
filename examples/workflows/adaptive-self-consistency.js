/**
 * Self-consistency / ensemble vote — run the SAME reasoning prompt N times and
 * let the answers vote.
 *
 * Sample the same question N times with cache:false (so each run re-rolls instead
 * of returning one cached answer), pull a structured final answer from each sample
 * (schema { answer }), then tally a majority vote. The dynamism is EMERGENT
 * CONFIDENCE: the agreement level falls out of the vote spread — unanimous samples
 * yield high confidence, a split field yields low confidence with the dissent
 * reported — rather than trusting a single run's self-assurance.
 *
 * Uses: ctx.agents(items, { concurrency }) for the fan-out, cache:false to sample
 * distinct draws, ctx.agent({ schema }) for a typed final answer.
 *
 * Input: { question: "..." , samples?: N (default 5) }.
 */
module.exports = async function workflow(ctx, input) {
  const safeParse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
  const norm = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

  const question = input?.question ?? input?.q ?? input?.text;
  if (!question) throw new Error('Pass { question: "..." } as workflow input.');

  // N samples, clamped so we never exceed the runtime's parallelism budget.
  const requested = Number(input?.samples ?? 5);
  const samples = Math.max(2, Math.min(requested, ctx.limits.concurrency, ctx.limits.maxAgents ?? requested));
  await ctx.log(`self-consistency: requested ${requested} samples, running ${samples}`, { concurrency: ctx.limits.concurrency });

  const ANSWER = {
    type: "object",
    additionalProperties: false,
    required: ["answer", "reasoning"],
    properties: {
      answer: { type: "string", description: "the final answer ONLY, as short and canonical as possible" },
      reasoning: { type: "string", description: "brief justification for this answer" },
    },
  };

  // Fan out the SAME prompt N times; cache:false forces independent draws (a per-sample
  // id keeps prompts distinct anyway so the cache can't collapse them into one).
  const draws = await ctx.agents(
    Array.from({ length: samples }, (_, i) => ({
      prompt:
        `Sample #${i + 1}. Reason step by step, then give your single best final answer.\n\n` +
        `Question: ${question}`,
      name: `sample-${i + 1}`,
      agentType: "researcher",
      tools: ["read", "grep", "find", "ls", "bash"],
      cache: false,
      schema: ANSWER,
      schemaOnInvalid: "null",
    })),
    { concurrency: Math.min(samples, ctx.limits.concurrency), settle: true },
  );

  // Extract a typed answer from each sample; drop runs that errored or failed schema.
  const parsed = (draws ?? [])
    .filter(Boolean)
    .map((r) => (r.data ?? safeParse(r.output)))
    .filter((v) => v && typeof v.answer === "string" && v.answer.trim())
    .map((v) => ({ answer: v.answer.trim(), reasoning: v.reasoning, key: norm(v.answer) }));

  if (parsed.length === 0) return "Self-consistency failed: no sample produced a parseable answer.";

  // Majority vote over normalized answers; tally drives the confidence, not any one run.
  const tally = new Map();
  for (const p of parsed) {
    const slot = tally.get(p.key) ?? { display: p.answer, count: 0, reasonings: [] };
    slot.count++;
    slot.reasonings.push(p.reasoning);
    tally.set(p.key, slot);
  }
  const ranked = [...tally.values()].sort((a, b) => b.count - a.count);
  const consensus = ranked[0];
  const total = parsed.length;
  const agreement = consensus.count / total;

  // EMERGENT confidence: derived from the vote spread, not self-reported by a model.
  const confidence = agreement === 1 ? "high" : agreement >= 0.6 ? "medium" : "low";
  const dissent = ranked.slice(1).map((s) => ({ answer: s.display, votes: s.count }));

  await ctx.log(
    `vote: "${consensus.display}" won ${consensus.count}/${total} -> ${confidence} confidence`,
    { distinctAnswers: ranked.length, dissent },
  );
  await ctx.writeArtifact("self-consistency.json", {
    question, samples: total, consensus: consensus.display, agreement, confidence, ranked, dissent,
  });

  const dissentLine = dissent.length
    ? `\nDissent: ${dissent.map((d) => `"${d.answer}" (${d.votes})`).join(", ")}`
    : "\nNo dissent — all samples agreed.";

  return (
    `Consensus answer: ${consensus.display}\n` +
    `Agreement: ${consensus.count}/${total} samples (${confidence} confidence).${dissentLine}\n\n` +
    `Sample reasoning for the consensus:\n${consensus.reasonings[0] ?? "(none)"}`
  );
};
