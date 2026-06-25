/**
 * Multi-modal sweep — cover by searching several DIFFERENT ways, then union + critic.
 *
 * Each searcher is blind to the others and uses a distinct modality (by-name/grep,
 * by-content/semantic, by-tests, by-git-history, by-dependency). One angle never finds
 * everything; the union does. A final critic checks which modality was thin and the
 * caller can re-sweep. Coverage-oriented dynamism.
 *
 * Uses: ctx.parallel([thunks]) (barrier — we union all modalities), ctx.agent({schema}).
 */
module.exports = async function workflow(ctx, input) {
  const safeParse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
  const target = input?.target ?? input?.text;
  if (!target) throw new Error('Pass { target: "what to find, e.g. all call sites of X" }');

  const modalities = input?.modalities ?? [
    { key: "by-name", how: "grep/glob for names, identifiers, and file paths" },
    { key: "by-content", how: "read and reason about semantics, not just string matches" },
    { key: "by-tests", how: "inspect tests/specs and fixtures that exercise it" },
    { key: "by-git", how: "use git log/blame to find recent or historical touch points" },
    { key: "by-deps", how: "follow imports/exports and the dependency graph" },
  ];

  // Barrier: every modality must finish before we union/dedupe (a real cross-branch merge).
  const sweeps = await ctx.parallel(
    modalities.map((m) => () =>
      ctx.agent(
        `Find: ${target}\nUse ONLY this modality: ${m.how}. Be exhaustive within it; ignore the others. ` +
          `Return a JSON array of { ref, evidence } (ref = file:line or symbol); [] if none.`,
        { name: `sweep-${m.key}`, agentType: "researcher", tools: ["read", "grep", "find", "ls", "bash"] },
      ).then((r) => ({ modality: m.key, hits: safeParse(r.output) ?? [] })),
    ),
  );

  // Union + dedupe by ref across modalities (plain code — the genuine reason for the barrier).
  const byRef = new Map();
  for (const s of sweeps.filter(Boolean)) {
    for (const h of Array.isArray(s.hits) ? s.hits : []) {
      if (!h || !h.ref) continue;
      const cur = byRef.get(h.ref) ?? { ref: h.ref, modalities: [], evidence: h.evidence };
      if (!cur.modalities.includes(s.modality)) cur.modalities.push(s.modality);
      byRef.set(h.ref, cur);
    }
  }
  const union = [...byRef.values()];
  await ctx.writeArtifact("sweep.json", { perModality: sweeps, union });
  await ctx.log(`union: ${union.length} refs across ${modalities.length} modalities`,
    { thin: modalities.map((m) => m.key).filter((k) => !sweeps.some((s) => s && s.modality === k && s.hits.length)) });

  const synthesis = await ctx.agent(
    `Consolidate these findings for: ${target}\nFlag refs found by only ONE modality (likely fragile) and any modality that came back empty (possible blind spot).\n\n${ctx.compact(union, 60000)}`,
    { name: "synthesis", agentType: "reviewer", tools: ["read", "grep", "find", "ls"] },
  );
  return synthesis.output;
};
