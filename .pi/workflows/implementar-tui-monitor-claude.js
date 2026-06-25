module.exports = async function workflow(ctx, input) {
  const agentTimeoutMs = input?.agentTimeoutMs ?? ctx.limits.agentTimeoutMs;
  const concurrency = Math.min(input?.concurrency ?? 3, ctx.limits.concurrency);
  const FILE = "extensions/dynamic-workflows.ts";
  const README = "README.md";
  const PLAN = "docs/workflows/ejecutar-tui-monitor-claude.md";
  await ctx.log("implementar-tui-monitor-claude:start", { input, concurrency });

  const allowDirtyTargets = input?.allowDirtyTargets === true;
  const status = await ctx.bash("git status --short", { timeoutMs: 20_000, throwOnError: false });
  await ctx.writeArtifact("preflight-status.txt", status.stdout + status.stderr);
  const dirtyTargets = status.stdout
    .split("\n")
    .filter((line) => line.includes(FILE) || line.includes(README));
  if (dirtyTargets.length > 0 && !allowDirtyTargets) {
    throw new Error(
      `Abort: target files are already dirty. Re-run with {\"allowDirtyTargets\":true} if intentional.\n${dirtyTargets.join("\n")}`,
    );
  }

  const baseline = await ctx.bash(
    "mkdir -p /tmp/pi-dynamic-workflows-baselines && cp extensions/dynamic-workflows.ts /tmp/pi-dynamic-workflows-baselines/dynamic-workflows.before-tui-monitor.ts && cp README.md /tmp/pi-dynamic-workflows-baselines/README.before-tui-monitor.md",
    { timeoutMs: 20_000, throwOnError: false },
  );
  await ctx.writeArtifact("baseline-copy.txt", baseline.stdout + baseline.stderr);

  const plan = await ctx.readFile(PLAN).catch((err) => `READ_PLAN_FAILED: ${err.message}`);
  const codeMap = await ctx.bash(
    "rg -n \"WorkflowDashboard|formatLiveRunView|workflowProgress|runWorkflowWithUi|readRunLogEvents|formatRunView|setWidget|WorkflowDashboardResult|cancelWorkflowRun|runWorkflowFromUi|handleInput|renderRuns|renderActivity|openWorkflowDashboard\" extensions/dynamic-workflows.ts README.md || true",
    { timeoutMs: 20_000, throwOnError: false },
  );
  await ctx.writeArtifact("implementation-context.json", { plan, codeMap: codeMap.stdout });

  const impl = await ctx.agent(
    `Implementa SOLO la Fase 1 MVP del plan en ${FILE}: TUI Monitor-first usando datos existentes.

Plan:
${plan}

Scope estricto:
- Agregar tab Monitor default en WorkflowDashboard.
- Rediseñar widget live para ser compacto y belowEditor.
- Derivar modelo de monitor desde logs/status existentes, sin nueva DSL todavía.
- Acciones reales: enter/v view, g graph, c cancel activo. Implementa r rerun solo si queda seguro y confirmado; si no, deja la acción fuera de la ayuda.
- Mantener render(width) <= width con truncateToWidth/visibleWidth.
- Actualizar README si cambia UX.

NO implementar todavía ctx.meta/ctx.phase/parallel/pipeline/schema. Eso queda para fases posteriores.
NO tocar worker, journal, resume/cache ni AgentOptions.
Lee el archivo antes de editar. Haz cambios quirúrgicos y conserva compatibilidad print/json/RPC.`,
    { name: "implement-mvp-monitor", tools: ["read", "bash", "edit", "write"], timeoutMs: agentTimeoutMs },
  );
  await ctx.writeArtifact("implementation.md", impl.output);

  const check1 = await ctx.bash(
    "printf '%s\n' '--- diff check ---' && git diff --check && printf '%s\n' '--- esbuild ---' && npx --yes esbuild extensions/dynamic-workflows.ts --platform=node --format=esm --packages=external --outfile=/tmp/pi-dynamic-workflows-check.mjs 2>&1 | head -100",
    { timeoutMs: 120_000, throwOnError: false },
  );
  await ctx.writeArtifact("check-after-implementation.txt", check1.stdout + check1.stderr);

  const reviews = await ctx.agents(
    [
      {
        name: "review-tui-width-input",
        prompt:
          "Review the current diff for TUI width/input/render bugs. Focus on render(width) overflow, ANSI width, requestRender after input, state index bounds, and widget placement. Cite exact file/line. Do not edit.",
        tools: ["read", "bash", "grep", "find", "ls"],
      },
      {
        name: "review-runtime-regression",
        prompt:
          "Review the current diff for runtime regressions in dynamic workflows: run/list/view/cancel/background/resume, print mode, status/widget cleanup. Cite exact file/line. Do not edit.",
        tools: ["read", "bash", "grep", "find", "ls"],
      },
      {
        name: "review-scope-docs",
        prompt:
          "Review whether implementation stayed within MVP scope and docs match behavior. Flag accidental DSL/runtime metadata changes. Cite exact file/line. Do not edit.",
        tools: ["read", "bash", "grep", "find", "ls"],
      },
      {
        name: "review-types-syntax",
        prompt:
          "Review TypeScript/syntax/null-safety risks in the current diff. Check likely compile errors and cite exact file/line. Do not edit.",
        tools: ["read", "bash", "grep", "find", "ls"],
      },
    ].map((review) => ({ ...review, timeoutMs: agentTimeoutMs })),
    { concurrency },
  );
  await ctx.writeArtifact("reviews.json", reviews);

  const reviewSynthesis = await ctx.agent(
    `Synthesize these review reports. Start with exactly one line: FIX_REQUIRED: yes or FIX_REQUIRED: no.
Then list BLOCKING issues, NONBLOCKING concerns, and accepted risks.

Reviews:
${ctx.compact(reviews, 100_000)}

Implementation output:
${impl.output}

Check output:
${check1.stdout}
${check1.stderr}`,
    { name: "review-synthesis", tools: ["read", "bash", "grep", "find", "ls"], timeoutMs: agentTimeoutMs },
  );
  await ctx.writeArtifact("review-synthesis.md", reviewSynthesis.output);

  let fixOutput = "No fix phase requested.";
  if (/FIX_REQUIRED:\s*yes/i.test(reviewSynthesis.output)) {
    const fix = await ctx.agent(
      `Fix ONLY blocking issues from the review synthesis in ${FILE} and ${README}. If a requested fix would exceed MVP scope, stop and explain.

Review synthesis:
${reviewSynthesis.output}

Rules: keep scope to MVP Monitor-first. Do not add DSL/runtime metadata. Do not touch worker, journal, resume/cache or AgentOptions. Run no destructive commands.`,
      { name: "fix-blockers", tools: ["read", "bash", "edit", "write"], timeoutMs: agentTimeoutMs },
    );
    fixOutput = fix.output;
  }
  await ctx.writeArtifact("fix.md", fixOutput);

  const finalCheck = await ctx.bash(
    "printf '%s\n' '--- git status ---' && git status --short && printf '%s\n' '--- diff check ---' && git diff --check && printf '%s\n' '--- esbuild ---' && npx --yes esbuild extensions/dynamic-workflows.ts --platform=node --format=esm --packages=external --outfile=/tmp/pi-dynamic-workflows-check.mjs 2>&1 | head -120 && printf '%s\n' '--- diff stat ---' && git diff --stat",
    { timeoutMs: 120_000, throwOnError: false },
  );
  await ctx.writeArtifact("final-check.txt", finalCheck.stdout + finalCheck.stderr);

  return [
    "# Implementación TUI Monitor-first",
    "",
    "## Implementación",
    impl.output,
    "",
    "## Review synthesis",
    reviewSynthesis.output,
    "",
    "## Fix",
    fixOutput,
    "",
    "## Final check",
    "~~~",
    finalCheck.stdout + finalCheck.stderr,
    "~~~",
  ].join("\n");
};
