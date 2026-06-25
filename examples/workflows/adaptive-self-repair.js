/**
 * Self-repair loop — generate, verify, feed failures back, repeat until green.
 *
 * The most "dynamic" shape: control flow is driven by a real check (tests / typecheck
 * / lint run via ctx.bash). On failure, the error output is fed back to the agent for a
 * targeted fix; on success, stop. Loops until green or maxAttempts — depth adapts to
 * how hard the task turns out to be, not a fixed count.
 *
 * Input: { task: "what to implement/fix", verifyCmd: "npm test" (or tsc/lint/...) }.
 * Note: the agent edits real files (write/edit tools); run on a target you can review.
 */
module.exports = async function workflow(ctx, input) {
  const task = input?.task ?? input?.text;
  if (!task) throw new Error('Pass { task: "...", verifyCmd: "npm test" }');
  const verifyCmd = input?.verifyCmd ?? "npm test";
  const maxAttempts = input?.maxAttempts ?? 4;

  let lastFailure = "";
  let attempt = 0;
  let green = false;

  while (attempt < maxAttempts) {
    attempt++;
    const prompt = attempt === 1
      ? `Implement this task by editing the repo files: ${task}\nKeep the change minimal and focused.`
      : `Your previous attempt did not pass \`${verifyCmd}\`. Fix it. Address these failures specifically; do not rewrite unrelated code.\n\nFailure output:\n${lastFailure.slice(0, 8000)}`;
    await ctx.agent(prompt, {
      name: `repair-attempt-${attempt}`,
      agentType: "implementer",
      tools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
    });

    // The CHECK drives the loop — not the agent's self-report.
    const check = await ctx.bash(verifyCmd, { timeoutMs: input?.verifyTimeoutMs ?? 600000 });
    await ctx.log(`attempt ${attempt}: ${verifyCmd} -> ${check.ok ? "GREEN" : `exit ${check.code}`}`);
    if (check.ok) { green = true; break; }
    lastFailure = (check.stderr || check.stdout || "").trim();
  }

  await ctx.writeArtifact("repair-result.json", { task, verifyCmd, attempts: attempt, green });
  if (!green) {
    await ctx.log(`gave up after ${attempt} attempts (not silently "done")`, { verifyCmd });
    return `Self-repair did NOT converge after ${attempt} attempts. Last failure:\n${lastFailure.slice(0, 4000)}`;
  }
  return `Self-repair converged: \`${verifyCmd}\` is green after ${attempt} attempt(s).`;
};
