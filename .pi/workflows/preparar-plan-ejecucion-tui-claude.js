module.exports = async function workflow(ctx, input) {
  const concurrency = Math.min(input?.concurrency ?? ctx.limits.concurrency, ctx.limits.concurrency);
  const agentTimeoutMs = input?.agentTimeoutMs ?? ctx.limits.agentTimeoutMs;
  await ctx.log("preparar-plan-ejecucion-tui-claude:start", { input, concurrency });

  const status = await ctx.bash(
    "git status --short && printf '\\n--- diff --stat ---\\n' && git diff --stat && printf '\\n--- untracked ---\\n' && git ls-files --others --exclude-standard",
    { timeoutMs: 20_000, throwOnError: false }
  );
  const codeMap = await ctx.bash(
    "rg -n \"WorkflowDashboard|formatLiveRunView|workflowProgress|runWorkflowWithUi|WorkflowRuntimeApi|AgentOptions|SubagentResult|WorkflowRunStatus|readRunLogEvents|formatRunView|runSubagent|agents: async|bash: async|writeRunStatus|events.jsonl|status.json|setWidget|setStatus|TOOL_ACTIONS\" extensions/dynamic-workflows.ts README.md docs skills .pi/workflows || true",
    { timeoutMs: 20_000, throwOnError: false }
  );
  const claudeFiles = await ctx.bash(
    "find \"$HOME/.claude\" -maxdepth 8 -type f -path '*/workflows/*' 2>/dev/null | sort | head -120",
    { timeoutMs: 20_000, throwOnError: false }
  );
  const currentPlan = await ctx.readFile("docs/workflows/inventar-mejor-tui-workflows.md").catch((err) => `READ_FAILED: ${err.message}`);
  const agents = await ctx.readFile("AGENTS.md").catch((err) => `READ_FAILED: ${err.message}`);

  const context = {
    goal: "Revisar profundamente el cambio planificado para Pi Dynamic Workflows: TUI Monitor-first + metadata/DSL inspirada en Claude, y preparar un plan ejecutable y un workflow de implementación.",
    status: status.stdout,
    codeMap: codeMap.stdout,
    claudeWorkflowFiles: claudeFiles.stdout,
    currentPlan,
    agents,
    constraints: [
      "Conventional Commits con scope y commits atómicos.",
      "No implementar todavía desde este workflow; preparar plan y workflow de implementación seguro.",
      "El workflow de implementación debe ser secuencial para edits y paralelo solo para reviews read-only.",
      "Respetar reglas TUI de Pi: render(width) no excede width, truncateToWidth/visibleWidth, requestRender tras mutaciones.",
    ],
  };
  await ctx.writeArtifact("context.json", context);

  const commonRules = `No edites archivos. Tu salida debe citar rutas/funciones concretas cuando sea posible. Distingue hechos, inferencias y recomendaciones. Si algo no tiene evidencia, marca INSUFFICIENT_EVIDENCE. Prioriza cambios atómicos y un plan que pueda ejecutarse con un workflow posterior.`;

  const reviews = await ctx.agents([
    {
      name: "deep-change-review",
      prompt: `Rol: revisor profundo del estado actual y del cambio propuesto.\n\nContexto:\n${ctx.compact(context, 60_000)}\n\nLee completo o por secciones relevantes:\n- docs/workflows/inventar-mejor-tui-workflows.md\n- extensions/dynamic-workflows.ts\n- README.md\n- AGENTS.md\n\nObjetivo: explicar qué cambió realmente en el plan, qué implica técnicamente y qué hay que tocar en el código.\n\n${commonRules}\n\nEntrega:\n## Qué cambió\n## Impacto técnico\n## Archivos/funciones a tocar\n## Dependencias y restricciones\n## Riesgos`,
      tools: ["read", "grep", "find", "ls"],
      timeoutMs: agentTimeoutMs,
    },
    {
      name: "claude-workflow-patterns-to-pi",
      prompt: `Rol: experto en workflows de Claude y migración de patrones a Pi.\n\nContexto:\n${ctx.compact(context, 50_000)}\n\nDebes leer estos workflows de Claude si existen:\n- ~/.claude/plugins/marketplaces/claude-plugins-official/plugins/code-modernization/workflows/extract-rules.js\n- ~/.claude/plugins/marketplaces/claude-plugins-official/plugins/code-modernization/workflows/harden-scan.js\n- ~/.claude/plugins/marketplaces/claude-plugins-official/plugins/code-modernization/workflows/uplift-deltas.js\n- los scripts bajo ~/.claude/projects/.../workflows/scripts/ listados en claudeWorkflowFiles\n\nObjetivo: convertir patrones de Claude en cambios concretos para Pi sin copiar complejidad innecesaria.\n\n${commonRules}\n\nEntrega:\n## Patrones de Claude observados\n## Qué copiar en MVP vs después\n## Modelo de datos recomendado\n## API/DSL recomendada\n## Pitfalls`,
      tools: ["read", "grep", "find", "ls"],
      timeoutMs: agentTimeoutMs,
    },
    {
      name: "implementation-plan-author",
      prompt: `Rol: autor de plan de implementación ejecutable.\n\nContexto:\n${ctx.compact(context, 60_000)}\n\nNecesitamos un plan por commits atómicos para implementar en extensions/dynamic-workflows.ts y docs. Debe separar: MVP TUI actual, metadata runtime, DSL Claude-like, docs/tests.\n\n${commonRules}\n\nEntrega:\n## Commit plan convencional\n## Orden de implementación\n## Comandos de verificación\n## Criterios de aceptación\n## Rollback/fallback`,
      tools: ["read", "grep", "find", "ls"],
      timeoutMs: agentTimeoutMs,
    },
    {
      name: "implementation-workflow-designer",
      prompt: `Rol: diseñador del workflow de implementación que se ejecutará después.\n\nContexto:\n${ctx.compact(context, 60_000)}\n\nDiseña un workflow Pi seguro que implemente este cambio: una fase Implement con un solo agente editor, Review con varios agentes read-only en paralelo, Fix secuencial si hay bloqueantes, FinalCheck con comandos. Debe escribir artifacts y verificar sintaxis.\n\n${commonRules}\n\nEntrega:\n## Estructura del workflow\n## Prompts de agentes\n## Límites recomendados\n## Herramientas permitidas por fase\n## Criterios para detenerse`,
      tools: ["read", "grep", "find", "ls"],
      timeoutMs: agentTimeoutMs,
    },
    {
      name: "risk-and-scope-critic",
      prompt: `Rol: crítico adversarial.\n\nContexto:\n${ctx.compact(context, 60_000)}\n\nTu objetivo es reducir scope y evitar que el workflow de implementación rompa un archivo grande. Identifica blockers, secuencia segura y qué NO hacer ahora.\n\n${commonRules}\n\nEntrega:\n## Bloqueantes\n## No hacer ahora\n## Riesgos top y mitigación\n## Scope mínimo viable\n## Señales para abortar`,
      tools: ["read", "grep", "find", "ls"],
      timeoutMs: agentTimeoutMs,
    }
  ], { concurrency });
  await ctx.writeArtifact("reviews.json", reviews);
  for (const review of reviews) {
    await ctx.writeArtifact(`agents/${String(review.id).padStart(4, "0")}-${review.name}.md`, review.output);
  }

  const synthesis = await ctx.agent(
    `Sintetiza un plan final, ejecutable y conservador para implementar la TUI Monitor-first y luego la metadata/DSL inspirada en Claude.\n\nDebe incluir:\n- diagnóstico profundo del cambio;\n- plan por commits atómicos con Conventional Commits y scope;\n- MVP exacto a implementar primero;\n- qué queda para fases posteriores;\n- diseño del workflow de implementación;\n- lista de archivos/funciones a tocar;\n- criterios de aceptación y comandos;\n- riesgos y abort conditions.\n\nContexto:\n${ctx.compact(context, 60_000)}\n\nReportes:\n${ctx.compact(reviews, 120_000)}`,
    { name: "synthesis-plan", tools: ["read", "grep", "find", "ls"], timeoutMs: agentTimeoutMs }
  );

  const planPath = "docs/workflows/ejecutar-tui-monitor-claude.md";
  const planDoc = `# Plan de ejecución: TUI Monitor-first + patrones Claude\n\nFecha: 2026-06-25\n\nGenerado por workflow: \`.pi/workflows/preparar-plan-ejecucion-tui-claude.js\`\n\nRun: \`${ctx.runId}\`\n\n## Síntesis\n\n${synthesis.output}\n\n## Artefactos\n\n- Run dir: \`${ctx.runDir}\`\n- Contexto: \`${ctx.runDir}/context.json\`\n- Reviews: \`${ctx.runDir}/reviews.json\`\n- Agentes: \`${ctx.runDir}/agents/\`\n`;
  await ctx.writeFile(planPath, planDoc);
  await ctx.writeArtifact("plan.md", planDoc);

  const implWorkflowPath = ".pi/workflows/implementar-tui-monitor-claude.js";
  const implWorkflowCode = `module.exports = async function workflow(ctx, input) {
  const agentTimeoutMs = input?.agentTimeoutMs ?? ctx.limits.agentTimeoutMs;
  const concurrency = Math.min(input?.concurrency ?? 3, ctx.limits.concurrency);
  const FILE = "extensions/dynamic-workflows.ts";
  const PLAN = "docs/workflows/ejecutar-tui-monitor-claude.md";
  await ctx.log("implementar-tui-monitor-claude:start", { input, concurrency });

  const baseline = await ctx.bash("mkdir -p /tmp/pi-dynamic-workflows-baselines && cp extensions/dynamic-workflows.ts /tmp/pi-dynamic-workflows-baselines/dynamic-workflows.before-tui-monitor.ts && git status --short", { timeoutMs: 20_000, throwOnError: false });
  await ctx.writeArtifact("baseline-status.txt", baseline.stdout + baseline.stderr);

  const plan = await ctx.readFile(PLAN).catch((err) => "READ_PLAN_FAILED: " + err.message);
  const codeMap = await ctx.bash("rg -n \\\"WorkflowDashboard|formatLiveRunView|workflowProgress|runWorkflowWithUi|readRunLogEvents|formatRunView|setWidget|WorkflowDashboardResult|cancelWorkflowRun|runWorkflowFromUi|handleInput|renderRuns|renderActivity\\\" extensions/dynamic-workflows.ts README.md || true", { timeoutMs: 20_000, throwOnError: false });
  await ctx.writeArtifact("implementation-context.json", { plan, codeMap: codeMap.stdout });

  const impl = await ctx.agent(
    \`Implementa SOLO la Fase 1 MVP del plan en \${FILE}: TUI Monitor-first usando datos existentes.\n\nPlan:\n\${plan}\n\nScope estricto:\n- Agregar tab Monitor default en WorkflowDashboard.\n- Rediseñar widget live para ser compacto y belowEditor.\n- Derivar modelo de monitor desde logs/status existentes, sin nueva DSL todavía.\n- Acciones reales: v/view, g/graph, r/rerun simple desde workflow seleccionado o input del run si es seguro, c/cancel activo, q/esc close.\n- Mantener render(width) <= width con truncateToWidth/visibleWidth.\n- Actualizar README si cambia UX.\n\nNO implementar todavía ctx.meta/ctx.phase/parallel/pipeline/schema. Eso queda para fases posteriores.\n\nLee el archivo antes de editar. Haz cambios quirúrgicos.\`,
    { name: "implement-mvp-monitor", tools: ["read", "bash", "edit", "write"], timeoutMs: agentTimeoutMs }
  );
  await ctx.writeArtifact("implementation.md", impl.output);

  const check1 = await ctx.bash("npx --yes esbuild extensions/dynamic-workflows.ts --loader=ts --outfile=/tmp/pi-dynamic-workflows-check.js 2>&1 | head -80", { timeoutMs: 120_000, throwOnError: false });
  await ctx.writeArtifact("check-after-implementation.txt", check1.stdout + check1.stderr);

  const reviews = await ctx.agents([
    { name: "review-tui-width-input", prompt: \`Review the current diff for TUI width/input/render bugs. Focus on render(width) overflow, requestRender after input, state index bounds, and widget placement. Cite exact file/line. Do not edit.\`, tools: ["read", "bash", "grep", "find", "ls"] },
    { name: "review-runtime-regression", prompt: \`Review the current diff for runtime regressions in dynamic workflows: run/list/view/cancel/background, print mode, status/widget cleanup. Cite exact file/line. Do not edit.\`, tools: ["read", "bash", "grep", "find", "ls"] },
    { name: "review-scope-docs", prompt: \`Review whether implementation stayed within MVP scope and docs match behavior. Cite exact file/line. Do not edit.\`, tools: ["read", "bash", "grep", "find", "ls"] }
  ].map((x) => ({ ...x, timeoutMs: agentTimeoutMs })), { concurrency });
  await ctx.writeArtifact("reviews.json", reviews);

  const reviewSynthesis = await ctx.agent(
    \`Synthesize these review reports. Return: BLOCKING issues that must be fixed before final, NONBLOCKING, and whether a fix agent should run.\n\nReviews:\n\${ctx.compact(reviews, 80_000)}\n\nImplementation output:\n\${impl.output}\n\nCheck output:\n\${check1.stdout}\\n\${check1.stderr}\`,
    { name: "review-synthesis", tools: ["read", "bash", "grep", "find", "ls"], timeoutMs: agentTimeoutMs }
  );
  await ctx.writeArtifact("review-synthesis.md", reviewSynthesis.output);

  const fix = await ctx.agent(
    \`Fix ONLY blocking issues from the review synthesis in \${FILE}. If there are no blocking issues, do not edit and say no changes needed.\n\nReview synthesis:\n\${reviewSynthesis.output}\n\nRules: keep scope to MVP Monitor-first. Do not add DSL/runtime metadata. Run no destructive commands.\`,
    { name: "fix-blockers", tools: ["read", "bash", "edit", "write"], timeoutMs: agentTimeoutMs }
  );
  await ctx.writeArtifact("fix.md", fix.output);

  const finalCheck = await ctx.bash("printf '%s\\n' '--- git status ---' && git status --short && printf '%s\\n' '--- esbuild ---' && npx --yes esbuild extensions/dynamic-workflows.ts --loader=ts --outfile=/tmp/pi-dynamic-workflows-check.js 2>&1 | head -120 && printf '%s\\n' '--- diff stat ---' && git diff --stat", { timeoutMs: 120_000, throwOnError: false });
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
    fix.output,
    "",
    "## Final check",
    "~~~",
    finalCheck.stdout + finalCheck.stderr,
    "~~~"
  ].join("\\n");
};
`;
  await ctx.writeFile(implWorkflowPath, implWorkflowCode);
  await ctx.writeArtifact("implementation-workflow.js", implWorkflowCode);

  return `Plan escrito en ${planPath}\nWorkflow de implementación escrito en ${implWorkflowPath}\n\n${synthesis.output}`;
};