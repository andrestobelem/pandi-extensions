module.exports = async function workflow(ctx, input) {
  const concurrency = Math.min(input?.concurrency ?? ctx.limits.concurrency, ctx.limits.concurrency);
  const agentTimeoutMs = input?.agentTimeoutMs ?? ctx.limits.agentTimeoutMs;
  const screenshots = input?.screenshots ?? [
    "/Users/andrestobelem/Desktop/Captura de pantalla 2026-06-25 a la(s) 02.29.20.png",
    "/Users/andrestobelem/Desktop/Captura de pantalla 2026-06-25 a la(s) 02.29.27.png",
  ];

  await ctx.log("inventar-mejor-tui-workflows:start", { input, concurrency, screenshots });

  const inventory = await ctx.bash(
    "rg -n \"class WorkflowDashboard|formatLiveRunView|setWorkflowRunningStatus|setWidget|setStatus|openWorkflowDashboard|WorkflowActivityEntry|formatRunView\" extensions/dynamic-workflows.ts README.md docs skills examples || true",
    { timeoutMs: 20_000, throwOnError: false },
  );

  const docsHints = await ctx.bash(
    "printf '%s\n' 'Pi TUI docs: /Users/andrestobelem/.nvm/versions/node/v24.16.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/tui.md' 'Examples: /Users/andrestobelem/.nvm/versions/node/v24.16.0/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/'",
    { timeoutMs: 5_000, throwOnError: false },
  );

  const context = {
    screenshots,
    inventory: inventory.stdout,
    docsHints: docsHints.stdout,
    goals: [
      "Mejorar visualizacion TUI de dynamic workflows en Pi",
      "Inspirarse en Claude Code /workflows pero superarlo",
      "Diseñar dashboard, widget live, estados, fases/agentes, controles y experiencia de teclado",
      "Mantener implementacion factible con API TUI actual de Pi",
    ],
  };
  await ctx.writeArtifact("context.json", context);

  const sharedRules = `
Patrón de trabajo: divergir primero, converger después. Tu rol debe proponer una perspectiva independiente; no busques consenso prematuro.
Reglas:
- No edites archivos.
- Usa evidencia del repo/docs/capturas cuando hagas afirmaciones concretas.
- Cita rutas/líneas cuando hables del estado actual del código.
- Separa: hechos observados, inferencias, riesgos, propuesta.
- Si no podés leer una captura o doc, dilo como BLOCKED_WITH_REASON y continúa con la evidencia disponible.
- Prioriza un MVP implementable en un archivo antes de ideas wow.`;

  const agents = [
    {
      name: "referencia-claude-y-capturas",
      prompt: `Analiza las capturas de Claude Code y extrae el lenguaje visual/UX que conviene replicar o mejorar.

Capturas:
${screenshots.map((p) => `- ${p}`).join("\n")}

Lee las imagenes con read. Tambien puedes leer README/docs existentes.
${sharedRules}

Entrega con este formato:
## Observaciones visuales
## Componentes UI detectados
## Qué copiar / qué evitar / qué mejorar
## Información mínima vs máxima en pantalla
## Implicancias para Pi`,
      tools: ["read", "grep", "find", "ls"],
    },
    {
      name: "factibilidad-pi-tui",
      prompt: `Eres experto en la API TUI de Pi. Diseña una implementacion factible para mejorar el dashboard de workflows.

Contexto inicial:
${ctx.compact(context, 30_000)}

Debes leer:
- extensions/dynamic-workflows.ts
- /Users/andrestobelem/.nvm/versions/node/v24.16.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/tui.md
- ejemplos relevantes en /Users/andrestobelem/.nvm/versions/node/v24.16.0/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/
${sharedRules}

Entrega con este formato:
## API/components de Pi a usar
## Funciones/clases exactas a tocar
## Plan incremental en commits pequeños
## Riesgos de ancho/caching/invalidation/performance
## Pruebas manuales`,
      tools: ["read", "grep", "find", "ls"],
    },
    {
      name: "ux-mejor-que-claude",
      prompt: `Inventa una UX superior a Claude para workflows dinamicos en Pi. No te limites a copiar.

Contexto:
${ctx.compact(context, 30_000)}
${sharedRules}

Piensa en:
- Vista default ideal.
- Estados emocionales: esperando, corriendo, completado, stale, fallo.
- Fases inferidas vs declaradas.
- Agentes con tokens/herramientas/idle cuando existan o placeholders cuando no.
- Shortcuts para view/cancel/save/rerun/filter.
- Widget compacto debajo/encima del editor.
- Como presentar costo/latencia sin saturar.
- Que seria una version MVP y una version wow.

Entrega:
## Principio de diseño
## Wireframe ASCII MVP
## Wireframe ASCII wow
## Prioridades must/should/could
## Decisiones que harían a Pi mejor que Claude`,
      tools: ["read", "grep", "find", "ls"],
    },
    {
      name: "critico-riesgos-y-scope",
      prompt: `Haz una revision critica de cualquier rediseño TUI para dynamic workflows.

Contexto:
${ctx.compact(context, 30_000)}

Busca en el codigo actual riesgos o restricciones.
${sharedRules}

Entrega:
## Qué NO deberíamos hacer ahora
## Riesgos top 5 con mitigación
## Cómo evitar romper TUI/RPC/print
## Criterios de aceptación
## Pruebas sugeridas`,
      tools: ["read", "grep", "find", "ls"],
    },
  ];

  const reviews = await ctx.agents(
    agents.map((agent) => ({ ...agent, timeoutMs: agentTimeoutMs })),
    { concurrency },
  );
  await ctx.writeArtifact("design-reviews.json", reviews);
  await ctx.log("design agents completed", { count: reviews.length });

  const synthesis = await ctx.agent(
    `Sintetiza estas propuestas en un plan de implementacion para mejorar MUCHO el TUI de dynamic workflows de Pi.

Patrón de trabajo: synthesis-as-product-designer + implementation judge. No promedies ideas; elegí una dirección, descartá sobreingeniería y preservá riesgos.

Requisitos:
- Inspirado en Claude pero mejor.
- Debe ser implementable en este repo con cambios concretos.
- Incluye wireframe final ASCII.
- Divide en MVP inmediato y mejoras wow posteriores.
- Lista archivos/funciones/clases a tocar.
- Incluye criterios de aceptacion y pruebas.
- Marca tradeoffs, supuestos y decisiones.
- Menciona agentes fallidos/vacíos si los hubiera.

Contexto:
${ctx.compact(context, 40_000)}

Reportes:
${ctx.compact(reviews, 90_000)}`,
    { name: "sintesis-plan-tui", tools: ["read", "grep", "find", "ls"], timeoutMs: agentTimeoutMs },
  );

  await ctx.writeArtifact("plan-tui-workflows.md", synthesis.output);
  return synthesis.output;
};
