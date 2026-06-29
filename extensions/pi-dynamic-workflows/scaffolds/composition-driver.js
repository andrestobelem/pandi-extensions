/**
 * Composition driver — parent workflow calling a reusable sub-workflow.
 *
 * Requires a sibling project/global workflow at `lib/verify-claims` (use the
 * `verify-claims-lib` pattern). The parent discovers claims, then delegates the
 * reusable verification phase with ctx.workflow("lib/verify-claims", args).
 *
 * Input: { topic: "...", maxClaims?: 8, skeptics?: 3 }
 */
module.exports = async function workflow(ctx, input) {
  const topic = input?.topic ?? input?.question ?? input?.text;
  if (!topic) throw new Error('Pass { topic: "claims to discover and verify" }.');
  const maxClaims = Math.max(1, Number.isFinite(+input?.maxClaims) ? Math.floor(+input.maxClaims) : 8);

  const finder = await ctx.agent(
    `Find up to ${maxClaims} concrete, falsifiable claims about the topic below. ` +
      `Return ONLY a JSON array of { id, claim, evidence }. Evidence can be a file:line, URL, or command observation.\n\n` +
      `Topic: ${topic}`,
    { name: "claim-finder", agentType: "researcher", tools: ["read", "grep", "find", "ls", "bash"] },
  );

  let claims = [];
  try { claims = JSON.parse(finder.output); } catch { claims = []; }
  claims = Array.isArray(claims) ? claims.filter((claim) => claim && claim.claim).slice(0, maxClaims) : [];
  if (claims.length === 0) return "No falsifiable claims found to verify.";
  if (claims.length >= maxClaims) await ctx.log("claim cap applied", { reviewed: claims.length, maxClaims });
  await ctx.writeArtifact("claims.json", claims);

  const verification = await ctx.workflow("lib/verify-claims", {
    claims,
    skeptics: input?.skeptics ?? 3,
    topic,
  });
  await ctx.writeArtifact("verification.json", verification);

  const synthesis = await ctx.agent(
    `Synthesize the verified/dropped claims below. Preserve uncertainty, cite evidence, and mention that verification was delegated to lib/verify-claims.\n\n` +
      `${ctx.compact(verification, 50000)}\n\nNow synthesize the verified/dropped claims above: preserve uncertainty, cite evidence, and note verification was delegated to lib/verify-claims.`,
    { name: "composition-synthesis", agentType: "reviewer", tools: ["read", "grep", "find", "ls"] },
  );
  await ctx.writeArtifact("summary.md", synthesis.output);
  return synthesis.output;
};
