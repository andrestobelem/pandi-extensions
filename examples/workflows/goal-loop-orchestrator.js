export default async function workflow(ctx, input = {}) {
  const repoRoot = input.repoRoot || process.cwd();
  const pass = input.pass || "N";
  const maxPasses = input.maxPasses || 8;
  const logPath = input.logPath || "docs/investigaciones/loop-mejora-continua.md";
  const hotFiles = input.hotFiles || ["extensions/dynamic-workflows.ts"];
  const objective = input.objective || "continuous improvement pass";

  ctx.log(`goal-loop-orchestrator pass ${pass}/${maxPasses}: scout -> candidate fanout -> synthesis -> log template`);
  ctx.log("This workflow is read-only except for workflow artifacts; implementation/review workflows must be explicit follow-up steps.");

  const scoutCommands = [
    { id: "status", cmd: "git status --short" },
    { id: "recent-log", cmd: "git log --oneline -8" },
    { id: "test", cmd: "npm test" },
    { id: "extensions-diff", cmd: "git diff --stat -- extensions/" },
    { id: "memory-tail", cmd: `test -f ${JSON.stringify(logPath)} && tail -120 ${JSON.stringify(logPath)} || true` },
    { id: "generated-workflows", cmd: "find .pi/workflows/generated -maxdepth 1 -type f 2>/dev/null | sort | tail -80" },
  ];

  const scout = [];
  for (const item of scoutCommands) {
    const result = await ctx.bash(item.cmd, { cwd: repoRoot, timeoutMs: item.id === "test" ? 120000 : 30000 });
    scout.push({ ...item, ok: result.ok, code: result.code, stdout: result.stdout, stderr: result.stderr });
  }
  await ctx.writeArtifact("scout.json", JSON.stringify(scout, null, 2));

  const scoutSummary = scout.map((s) => `## ${s.id}\ncmd: ${s.cmd}\nok: ${s.ok} code: ${s.code}\nstdout:\n${String(s.stdout || "").slice(0, 6000)}\nstderr:\n${String(s.stderr || "").slice(0, 2000)}`).join("\n\n");

  const perspectives = [
    {
      id: "safe-high-value-e2e",
      prompt: "Find one high-value, safe improvement candidate focused on durable tests/e2e/harness gaps. Avoid hot files and other-session work.",
    },
    {
      id: "docs-handoff-proposal",
      prompt: "Find one candidate where the best action is a documented proposal/handoff because implementation would touch hot core or other-session files.",
    },
    {
      id: "artifact-completeness-critic",
      prompt: "Critique the pass process itself: what evidence/artifacts must be created so an independent verifier can confirm every criterion?",
    },
    {
      id: "safety-ownership-critic",
      prompt: "Identify ownership/hot-file risks in the current worktree and state which paths must not be edited this pass.",
    },
  ];

  const basePrompt = `Repo root: ${repoRoot}\nObjective: ${objective}\nPass: ${pass}/${maxPasses}\nLog path: ${logPath}\nHot files: ${hotFiles.join(", ")}\n\nScout evidence:\n${scoutSummary}\n\nReturn fixed sections:\nVerdict: CANDIDATE | PROPOSAL | DRY | BLOCKED\nCandidate: one concrete improvement or proposal\nWhy high value:\nFiles allowed / forbidden:\nVerification commands:\nWorkflow artifacts required:\nRisks:\n`;

  const reviews = await ctx.agents(
    perspectives.map((p) => ({ id: p.id, prompt: `${basePrompt}\n\nPerspective: ${p.prompt}` })),
    {
      concurrency: Math.min(4, ctx.limits?.concurrency || 4),
      settle: true,
      agentType: "reviewer",
      tools: ["read", "grep", "find", "ls"],
      includeSkills: [],
      includeExtensions: [],
    },
  );
  await ctx.writeArtifact("candidate-reviews.json", JSON.stringify(reviews, null, 2));

  const usable = reviews.filter(Boolean).map((r) => `# ${r.name || r.id}\nok:${r.ok}\n${r.output || ""}`).join("\n\n---\n\n");
  if (reviews.some((r) => !r || r.ok === false)) ctx.log(`${reviews.filter((r) => !r || r.ok === false).length} reviewer branches failed or timed out; synthesis must mention partial coverage.`);

  const synthesis = await ctx.agent(`${basePrompt}\n\nReviewer outputs:\n${usable}\n\nSynthesize a single pass plan. Do not claim implementation is done. Choose exactly one of: REAL_IMPLEMENTATION_SAFE, PROPOSAL_ONLY, DRY_PASS, BLOCKED. Include a ready-to-copy Markdown log entry skeleton with placeholders for workflow run ids, adversarial review run id, commands, and evidence. Explicitly list any files that must not be touched.`, {
    agentType: "planner",
    tools: ["read", "grep", "find", "ls"],
    includeSkills: [],
    includeExtensions: [],
  });

  await ctx.writeArtifact("synthesis.md", synthesis.output || String(synthesis));

  const checklist = `# Goal loop pass checklist\n\n- [ ] Inline scout evidence captured in this run: scout.json\n- [ ] Candidate synthesis captured: synthesis.md\n- [ ] If implementing, create a separate task-specific adversarial review workflow under generated/<slug>-review\n- [ ] Verify with npm test plus relevant node --check/e2e/esbuild\n- [ ] Append ${logPath} with workflow name, run id, artifact dir, candidate decision, review result, verification commands, and safeguards\n- [ ] Do not touch hot files: ${hotFiles.join(", ")}\n- [ ] Do not edit untracked/modified files owned by another session; produce proposal/blocked instead\n`;
  await ctx.writeArtifact("checklist.md", checklist);

  return {
    pass,
    maxPasses,
    logPath,
    hotFiles,
    artifacts: ["scout.json", "candidate-reviews.json", "synthesis.md", "checklist.md"],
    synthesis: synthesis.output || String(synthesis),
  };
}
