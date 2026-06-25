/**
 * ROUTER / classify-and-dispatch: classify the input, then dispatch to a
 * SPECIALIZED handler chosen from a map by category.
 *
 * A cheap classifier returns a typed { category, confidence }. The dynamism:
 * the branch taken is DECIDED by that result — each category maps to its own
 * prompt / agentType / tool-set, so a "bug" goes to a reviewer with code tools
 * while a "docs" request goes to a researcher. If confidence is low (or the
 * category is unknown), we DON'T guess: we ask one disambiguation question and
 * re-route, falling back to a generic handler if it's still unclear.
 *
 * Uses: ctx.agent({ schema }) for the typed verdict, a handler map keyed by
 * category, and result-driven branch selection (no fixed call graph).
 */
module.exports = async function workflow(ctx, input) {
  const safeParse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
  const request = input?.request ?? input?.text ?? input?.q;
  if (!request) throw new Error('Pass { request: "..." } as workflow input.');
  const minConfidence = Number(input?.minConfidence ?? 0.6);

  // Each category owns its dispatch config: distinct prompt framing, agentType, tools.
  const HANDLERS = {
    bug: {
      desc: "a defect/bug report or a failing behavior to diagnose",
      agentType: "reviewer",
      tools: ["read", "grep", "find", "ls", "bash"],
      build: (req) => `Diagnose this bug. Reproduce the reasoning, locate the likely root cause, cite file:line, and propose a minimal fix.\n\nReport: ${req}`,
    },
    feature: {
      desc: "a request to design or implement new functionality",
      agentType: "planner",
      tools: ["read", "grep", "find", "ls"],
      build: (req) => `Plan this feature. Outline the approach, the files to touch, edge cases, and a stepwise implementation order.\n\nRequest: ${req}`,
    },
    docs: {
      desc: "a question answered by reading docs/code, no change needed",
      agentType: "researcher",
      tools: ["read", "grep", "find", "ls"],
      build: (req) => `Answer this question from the repo's docs and code. Cite the sources you used; say so if the answer isn't present.\n\nQuestion: ${req}`,
    },
    ops: {
      desc: "a build/test/deploy/runtime operations task",
      agentType: "implementer",
      tools: ["read", "grep", "find", "ls", "bash"],
      build: (req) => `Handle this ops task. Inspect the relevant config/scripts, run safe read-only checks, and give exact commands to run.\n\nTask: ${req}`,
    },
  };
  // Generic catch-all when the category is unknown or stays ambiguous.
  const GENERIC = {
    agentType: "researcher",
    tools: ["read", "grep", "find", "ls"],
    build: (req) => `Handle this request as best you can, stating assumptions up front since its intent is ambiguous.\n\nRequest: ${req}`,
  };
  const categories = Object.keys(HANDLERS);

  const VERDICT = {
    type: "object",
    additionalProperties: false,
    required: ["category", "confidence", "why"],
    properties: {
      category: { type: "string", description: `one of: ${categories.join(" | ")} | unknown` },
      confidence: { type: "number", description: "0..1 — how sure you are of the category" },
      why: { type: "string", description: "one short sentence" },
    },
  };

  const menu = categories.map((c) => `- ${c}: ${HANDLERS[c].desc}`).join("\n");
  const classify = (req, name) =>
    ctx.agent(
      `Classify the request below into exactly one category (or "unknown" if none fit).\n\nCategories:\n${menu}\n\nRequest: ${req}`,
      { name, agentType: "planner", tools: ["read", "grep", "find", "ls"], schema: VERDICT },
    ).then((r) => r.data ?? safeParse(r.output) ?? { category: "unknown", confidence: 0 });

  // 1) CLASSIFY (cheap, typed).
  let v = await classify(request, "classify-0");
  await ctx.log(`classify: category=${v.category} confidence=${v.confidence}`, { why: v.why });

  let effectiveRequest = request;
  // 2) DISAMBIGUATE once if unsure — ask a sharpening question, then re-route.
  if (!HANDLERS[v.category] || v.confidence < minConfidence) {
    const q = await ctx.agent(
      `The request below is ambiguous to route. Ask ONE sharp clarifying question (and only the question) that would best disambiguate which of these it is:\n${menu}\n\nRequest: ${request}`,
      { name: "disambiguate", agentType: "planner", tools: [] },
    );
    // No human in the loop: append the sharpening question as added context and re-classify.
    effectiveRequest = `${request}\n\n[Routing note — consider: ${q.output.trim()}]`;
    v = await classify(effectiveRequest, "classify-1");
    await ctx.log(`re-classify: category=${v.category} confidence=${v.confidence}`, { why: v.why });
  }

  // 3) DISPATCH: branch chosen by the classifier's result.
  const handler = (HANDLERS[v.category] && v.confidence >= minConfidence) ? HANDLERS[v.category] : GENERIC;
  const route = handler === GENERIC ? "generic" : v.category;
  await ctx.log(`dispatch -> ${route} (agentType=${handler.agentType})`);
  await ctx.writeArtifact("routing.json", { request, verdict: v, route });

  const result = await ctx.agent(handler.build(effectiveRequest), {
    name: `handle-${route}`,
    agentType: handler.agentType,
    tools: handler.tools,
  });
  return result.output;
};
