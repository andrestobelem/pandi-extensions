/**
 * Scout -> dynamic fan-out -> pipeline with per-item adaptive depth.
 *
 * The work-list is DISCOVERED by scouting inline (not assumed), then each file
 * flows through a pipeline: a cheap structured classification, and a deep review
 * ONLY for the items that turn out high-signal. Low-risk items short-circuit.
 * That per-item branching (spend more only where it pays) is dynamism.
 *
 * Uses: ctx.bash (scout), ctx.pipeline(items, ...stages) with stage
 * (value, originalItem, index), ctx.agent({ schema }) for a typed verdict.
 */
module.exports = async function workflow(ctx, input) {
  const safeParse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
  const pattern = input?.pattern ?? "\\.(ts|tsx|js|jsx|py|go|rs)$";
  const maxFiles = Number(input?.maxFiles ?? 40);

  // 1) SCOUT inline — discover the real work-list and its size before committing.
  const scout = await ctx.bash(`git ls-files | grep -E '${pattern}' | head -${maxFiles}`, { throwOnError: true });
  const files = scout.stdout.split("\n").filter(Boolean);
  await ctx.log(`scouted ${files.length} files`, { pattern });
  if (files.length === 0) return "No files matched; nothing to review.";

  const VERDICT = {
    type: "object",
    additionalProperties: false,
    required: ["risk", "why"],
    properties: {
      risk: { type: "string", description: "one of: high | medium | low" },
      why: { type: "string", description: "one short sentence" },
    },
  };

  // 2) PIPELINE: classify every file (cheap), deep-review only high/medium (adaptive depth).
  const reviewed = await ctx.pipeline(
    files,
    (file, _orig, i) =>
      ctx.agent(`Classify the risk of bugs/security issues in ${file}. Be quick; do not deep-dive.`, {
        name: `classify-${i}`,
        agentType: "reviewer",
        tools: ["read", "grep"],
        schema: VERDICT,
      }).then((r) => ({ file, verdict: r.data ?? safeParse(r.output) })),
    (c, _orig, i) => {
      const risk = c.verdict?.risk;
      if (risk !== "high" && risk !== "medium") return { ...c, deep: null }; // short-circuit low risk
      return ctx.agent(
        `Deep review ${c.file} for the risk you flagged ("${c.verdict?.why}"). Cite file:line for each finding; say NO_FINDINGS if none.`,
        { name: `deep-${i}`, agentType: "reviewer", tools: ["read", "grep", "find", "ls"] },
      ).then((r) => ({ ...c, deep: r.output }));
    },
  );

  const findings = reviewed
    .filter(Boolean)
    .filter((c) => c.deep && !/NO_FINDINGS/.test(c.deep));
  await ctx.writeArtifact("reviewed.json", reviewed);
  await ctx.log(`deep-reviewed ${findings.length}/${files.length} (rest were low-risk or clean)`);

  const synthesis = await ctx.agent(
    `Synthesize prioritized findings from these deep reviews. Deduplicate and drop unsupported claims.\n\n${ctx.compact(findings, 60000)}`,
    { name: "synthesis", agentType: "reviewer", tools: ["read", "grep", "find", "ls"] },
  );
  return synthesis.output;
};
