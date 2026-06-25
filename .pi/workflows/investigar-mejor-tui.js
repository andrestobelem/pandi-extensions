module.exports = async function workflow(ctx, input) {
  const concurrency = Math.min(input?.concurrency ?? ctx.limits.concurrency, ctx.limits.concurrency);
  const agentTimeoutMs = input?.agentTimeoutMs ?? ctx.limits.agentTimeoutMs;
  const screenshots = input?.screenshots ?? [
    "/Users/andrestobelem/Desktop/Captura de pantalla 2026-06-25 a la(s) 02.29.20.png",
    "/Users/andrestobelem/Desktop/Captura de pantalla 2026-06-25 a la(s) 02.29.27.png",
  ];

  await ctx.log("investigar-mejor-tui:start", { input, concurrency, screenshots });

  const codeMap = await ctx.bash(
    "rg -n \"class WorkflowDashboard|formatLiveRunView|workflowProgress|setWorkflowRunningStatus|setWorkflowFinishedStatus|openWorkflowDashboard|collectWorkflowActivity|formatRunView|runWorkflowWithUi|startWorkflowBackground|WorkflowActivityEntry|ctx.ui.setWidget|ctx.ui.setStatus\" extensions/dynamic-workflows.ts README.md docs skills || true",
    { timeoutMs: 20_000, throwOnError: false }
  );

  const artifactMap = await ctx.bash(
    "find .pi/workflow-runs -maxdepth 3 -type f \\( -name 'ux-superior.md' -o -name 'plan-tui-workflows.md' -o -name 'implementacion-factible.md' -o -name 'critico-scope.md' \\) 2>/dev/null | sort || true",
    { timeoutMs: 10_000, throwOnError: false }
  );

  const context = {
    goal: "Investigar cómo hacer la mejor TUI para la extensión Pi Dynamic Workflows, con foco en dashboard/monitor/widgets para runs y subagentes.",
    codeMap: codeMap.stdout,
    artifactMap: artifactMap.stdout,
    docs: [
      "/Users/andrestobelem/.nvm/versions/node/v24.16.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/tui.md",
      "/Users/andrestobelem/.nvm/versions/node/v24.16.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md",
      "/Users/andrestobelem/.nvm/versions/node/v24.16.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/themes.md",
      "/Users/andrestobelem/.nvm/versions/node/v24.16.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/keybindings.md"
    ],
    examplesDir: "/Users/andrestobelem/.nvm/versions/node/v24.16.0/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions",
    screenshots,
    currentMVPGuess: [
      "Derivar modelo de monitor desde logs/status.json/events.jsonl.",
      "Widget compacto belowEditor, no log spam.",
      "Dashboard con tab Monitor por defecto y 3 columnas fases/agentes/detalle.",
      "Acciones visibles: view, graph, run/rerun, cancel, close.",
      "Respeto estricto a width/truncateToWidth e invalidate."
    ]
  };
  await ctx.writeArtifact("context.json", context);

  const rules = `Reglas: no edites archivos. Cita rutas y, cuando puedas, líneas usando el codeMap o búsquedas. Separa hechos observados, inferencias y recomendaciones. Prioriza un MVP implementable en extensions/dynamic-workflows.ts antes de ideas wow. Si falta evidencia, di INSUFFICIENT_EVIDENCE.`;

  const agents = [
    {
      name: "estado-actual-repo",
      prompt: `Rol: auditor del estado actual del repo.\n\nObjetivo: entender qué TUI existe hoy para dynamic workflows y dónde están sus límites.\n\nContexto precomputado:\n${ctx.compact(context, 35000)}\n\nDebes leer: extensions/dynamic-workflows.ts, README.md, docs/workflows/inventar-mejor-tui-workflows.md y el artefacto ux-superior.md si existe en artifactMap.\n\n${rules}\n\nEntrega:\n## Estado actual\n## Buenas bases que conservar\n## Problemas UX/TUI detectados\n## Lugares exactos del código a tocar\n## Datos que ya existen vs datos que faltan`,
      tools: ["read", "grep", "find", "ls"],
      timeoutMs: agentTimeoutMs
    },
    {
      name: "pi-tui-primitivas-y-pitfalls",
      prompt: `Rol: experto en API TUI de Pi.\n\nObjetivo: extraer los constraints y patrones que debemos seguir para construir una TUI excelente y robusta.\n\nContexto:\n${ctx.compact(context, 30000)}\n\nDebes leer docs/tui.md completo y ejemplos relevantes: preset.ts, tools.ts, qna.ts, status-line.ts, plan-mode/index.ts, custom-footer.ts, modal-editor.ts, overlay-qa-tests.ts, snake.ts, todo.ts.\n\n${rules}\n\nEntrega:\n## Primitivas TUI disponibles\n## Reglas duras de render/ancho/input/theme\n## Patrones reutilizables\n## Pitfalls y mitigaciones\n## Recomendación de arquitectura del componente`,
      tools: ["read", "grep", "find", "ls"],
      timeoutMs: agentTimeoutMs
    },
    {
      name: "ux-producto-mejor-que-claude",
      prompt: `Rol: product designer de TUI para herramientas agenticas.\n\nObjetivo: diseñar una UX superior a Claude Code /workflows para Pi, sin sobrecargar pantalla.\n\nContexto:\n${ctx.compact(context, 30000)}\n\nLee las capturas si están disponibles con read. Lee también docs/workflows/inventar-mejor-tui-workflows.md y artefactos previos listados.\n\n${rules}\n\nEntrega:\n## Principios de diseño\n## Qué copiar / evitar / mejorar\n## Wireframe ASCII MVP\n## Widget compacto\n## Estados y acciones\n## Wow posterior`,
      tools: ["read", "grep", "find", "ls"],
      timeoutMs: agentTimeoutMs
    },
    {
      name: "critico-scope-riesgos",
      prompt: `Rol: revisor adversarial.\n\nObjetivo: reducir scope y prevenir bugs de TUI, performance o integración.\n\nContexto:\n${ctx.compact(context, 30000)}\n\nLee extensions/dynamic-workflows.ts y docs/tui.md.\n\n${rules}\n\nEntrega:\n## Qué NO hacer ahora\n## Riesgos top con mitigación\n## Criterios de aceptación\n## Plan MVP si solo tocamos un archivo\n## Pruebas manuales mínimas`,
      tools: ["read", "grep", "find", "ls"],
      timeoutMs: agentTimeoutMs
    }
  ];

  const reviews = await ctx.agents(agents, { concurrency });
  await ctx.writeArtifact("reviews.json", reviews);
  for (const review of reviews) {
    await ctx.writeArtifact(`agents/${String(review.id).padStart(4, "0")}-${review.name}.summary.md`, review.output);
  }

  const synthesis = await ctx.agent(
    `Sintetiza una investigación final y un plan accionable para hacer la mejor TUI de Pi Dynamic Workflows.\n\nNo promedies: elige una dirección concreta. Debe servir para decidir si implementamos después.\n\nIncluye:\n- diagnóstico actual;\n- visión de producto;\n- MVP inmediato en orden;\n- wireframe ASCII;\n- cambios concretos en código;\n- reglas técnicas de Pi TUI que no debemos romper;\n- criterios de aceptación y pruebas;\n- fuera de scope;\n- rutas de artefactos relevantes.\n\nContexto:\n${ctx.compact(context, 45000)}\n\nReportes:\n${ctx.compact(reviews, 100000)}`,
    { name: "sintesis-investigacion-tui", tools: ["read", "grep", "find", "ls"], timeoutMs: agentTimeoutMs }
  );

  await ctx.writeArtifact("investigacion-mejor-tui.md", synthesis.output);
  return synthesis.output;
};