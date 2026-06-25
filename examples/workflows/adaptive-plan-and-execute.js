/**
 * Plan-and-execute with REPLAN — a plan that rewrites itself when reality bites.
 *
 * A planner emits ordered steps (schema: { steps:[{id,goal}] }). We execute them in
 * order, one agent per step, and after each step VERIFY success (the executor returns a
 * typed { done, evidence }; we trust the typed flag, not prose). On a failed step we do
 * NOT blindly retry: a second planner REPLANS the remaining work from the point of
 * failure, given the failure context + what already succeeded, and we swap in the new
 * tail. Loop until the plan is exhausted or replans run out.
 *
 * Dynamism: the step list is not fixed — its tail is regenerated from real results, so
 * the path through the work adapts to what actually happened mid-execution.
 *
 * Input: { goal: "the overall objective", maxReplans?: number, maxSteps?: number }.
 */
module.exports = async function workflow(ctx, input) {
  const safeParse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
  const goal = input?.goal ?? input?.task ?? input?.text;
  if (!goal) throw new Error('Pass { goal: "..." } as workflow input.');
  const maxReplans = input?.maxReplans ?? 3;
  const maxSteps = input?.maxSteps ?? 12; // hard cap on total step executions across replans

  const PLAN = {
    type: "object",
    additionalProperties: false,
    required: ["steps"],
    properties: {
      steps: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "goal"],
          properties: {
            id: { type: "string", description: "short stable slug for the step" },
            goal: { type: "string", description: "what this step must achieve" },
          },
        },
      },
    },
  };

  const STEP_RESULT = {
    type: "object",
    additionalProperties: false,
    required: ["done", "evidence"],
    properties: {
      done: { type: "boolean", description: "true ONLY if the step's goal was fully achieved" },
      evidence: { type: "string", description: "concrete proof or, on failure, why it failed" },
    },
  };

  // Initial plan.
  const plannerTools = ["read", "grep", "find", "ls"];
  const p0 = await ctx.agent(
    `Break this objective into a short ordered list of concrete, independently-verifiable steps.\n` +
      `Each step needs a stable id and a precise goal. Keep it minimal; no filler steps.\n\nObjective: ${goal}`,
    { name: "planner-initial", agentType: "planner", tools: plannerTools, schema: PLAN },
  );
  let plan = (p0.data ?? safeParse(p0.output))?.steps ?? [];
  if (!plan.length) throw new Error("Planner produced no steps.");
  await ctx.log("initial plan", { steps: plan.map((s) => s.id), count: plan.length });

  const executed = []; // { id, goal, done, evidence }
  let replans = 0;
  let cursor = 0;
  let stepsRun = 0;
  let aborted = null;

  while (cursor < plan.length) {
    if (stepsRun >= maxSteps) {
      aborted = `hit maxSteps=${maxSteps} step-execution cap`;
      await ctx.log("aborting: step cap reached", { stepsRun, maxSteps });
      break;
    }
    const step = plan[cursor];
    stepsRun++;

    const done = executed.filter((e) => e.done);
    const context = done.length
      ? `Already completed:\n${done.map((e) => `- [${e.id}] ${e.goal} -> ${e.evidence}`).join("\n")}`
      : "Nothing completed yet.";

    const r = await ctx.agent(
      `Overall objective: ${goal}\n\n${context}\n\n` +
        `Execute ONLY this step now: [${step.id}] ${step.goal}\n` +
        `Report whether the step's goal was fully achieved with concrete evidence.`,
      {
        name: `exec-${step.id}-${stepsRun}`,
        agentType: "implementer",
        tools: ["read", "grep", "find", "ls", "bash"],
        schema: STEP_RESULT,
      },
    );
    const res = r.data ?? safeParse(r.output) ?? {};
    // The typed flag drives control flow; absent/unparseable => treat as failure (don't fake success).
    const ok = res.done === true;
    executed.push({ id: step.id, goal: step.goal, done: ok, evidence: res.evidence ?? "(no structured result)" });
    await ctx.log(`step ${cursor + 1}/${plan.length} [${step.id}] -> ${ok ? "OK" : "FAIL"}`, { stepsRun });

    if (ok) { cursor++; continue; }

    // REPLAN: regenerate the remaining tail from the failure, instead of retrying blindly.
    if (replans >= maxReplans) {
      aborted = `step [${step.id}] failed and replan budget (${maxReplans}) is exhausted`;
      await ctx.log("aborting: out of replans", { failedStep: step.id, replans });
      break;
    }
    replans++;
    const remaining = plan.slice(cursor); // failed step + everything after it
    const rp = await ctx.agent(
      `Replan the remaining work toward the objective after a step failed mid-execution.\n\n` +
        `Objective: ${goal}\n\n` +
        `Completed so far:\n${done.map((e) => `- [${e.id}] ${e.goal}`).join("\n") || "(none)"}\n\n` +
        `FAILED step [${step.id}] ${step.goal}\nFailure detail: ${executed[executed.length - 1].evidence}\n\n` +
        `Originally-remaining steps: ${remaining.map((s) => s.id).join(", ")}\n\n` +
        `Produce a NEW ordered list of steps that still achieves the objective, working around or fixing the failure. ` +
        `Use fresh ids if the approach changes. Do not include already-completed steps.`,
      { name: `replanner-${replans}`, agentType: "planner", tools: plannerTools, schema: PLAN },
    );
    const newTail = (rp.data ?? safeParse(rp.output))?.steps ?? [];
    if (!newTail.length) {
      aborted = `replan #${replans} produced no steps after [${step.id}] failed`;
      await ctx.log("aborting: empty replan", { replans });
      break;
    }
    // Swap the failed tail for the freshly-planned one; resume the cursor at its head.
    plan = plan.slice(0, cursor).concat(newTail);
    await ctx.log(`replan #${replans}`, { from: step.id, newSteps: newTail.map((s) => s.id), planLen: plan.length });
  }

  const allDone = !aborted && executed.length > 0 && executed.every((e) => e.done) && cursor >= plan.length;
  await ctx.writeArtifact("plan-and-execute.json", {
    goal, finalPlan: plan, executed, replans, stepsRun, aborted, succeeded: allDone,
  });

  if (allDone) {
    return `Objective reached after ${stepsRun} step(s) and ${replans} replan(s).\n` +
      executed.map((e) => `- [${e.id}] OK: ${e.evidence}`).join("\n");
  }
  return `Did NOT complete the objective (${aborted ?? "incomplete"}). ` +
    `Ran ${stepsRun} step(s), ${replans} replan(s).\nLast outcomes:\n` +
    executed.slice(-5).map((e) => `- [${e.id}] ${e.done ? "OK" : "FAIL"}: ${e.evidence}`).join("\n");
};
