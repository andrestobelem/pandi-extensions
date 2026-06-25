module.exports = async function workflow(ctx, input) {
  const agentTimeoutMs = input?.agentTimeoutMs ?? Math.min(ctx.limits.agentTimeoutMs, 300_000);
  const screenshots = input?.screenshots ?? [
    "/Users/andrestobelem/Desktop/Captura de pantalla 2026-06-25 a la(s) 02.29.20.png",
    "/Users/andrestobelem/Desktop/Captura de pantalla 2026-06-25 a la(s) 02.29.27.png",
  ];

  await ctx.log("inventar-mejor-tui-workflows-lite:start", { input, screenshots });

  const codeMap = await ctx.bash(
    "rg -n \"class WorkflowDashboard|formatLiveRunView|WorkflowActivityEntry|setWorkflowRunningStatus|openWorkflowDashboard|startWorkflowBackground|formatRunView\" extensions/dynamic-workflows.ts README.md skills docs || true",
    { timeoutMs: 20_000, throwOnError: false },
  );

  const context = {
    screenshots,
    codeMap: codeMap.stdout,
    externalResearchSummary: "Claude Code /workflows muestra runs por fases, agentes por fase, metricas de agentes/tokens/tiempo, controles para pause/stop/save/filter y drill-down por agente. Ultracode decide automaticamente workflows para tareas sustantivas.",
    desiredOutcome: "TUI de Pi para dynamic workflows inspirado en Claude pero mejor: mas claro, mas accionable, con widget live y dashboard monitor de fases/agentes.",
  };
  await ctx.writeArtifact("context.json", context);

  const ux = await ctx.agent(
    `Diseña una UX superior para el TUI de dynamic workflows de Pi.

Patrón: generación enfocada. Propón una dirección fuerte, no una lista genérica.

Capturas de referencia (lee las imagenes):
${screenshots.map((p) => `- ${p}`).join("\n")}

Contexto:
${ctx.compact(context, 20_000)}

Reglas:
- Si no podés leer una captura, dilo y continúa.
- Separa hechos observados, inferencias y propuesta.
- Prioriza MVP implementable antes de wow.

Entrega en español:
## Qué copiar de Claude y qué mejorar
## Wireframe ASCII final
## Estados: running/completed/failed/stale/cancelled
## Widget compacto debajo del editor
## Dashboard monitor con fases/agentes/actividad
## Prioridad MVP vs wow`,
    { name: "ux-superior", tools: ["read", "grep", "find", "ls"], timeoutMs: agentTimeoutMs },
  );
  await ctx.writeArtifact("ux-superior.md", ux.output);

  const implementation = await ctx.agent(
    `Aterriza esta UX a cambios concretos en el repo.

Patrón: implementación factible. Convierte diseño en pasos pequeños y verificables.

Debes leer:
- extensions/dynamic-workflows.ts
- README.md
- docs/workflows/inventar-mejor-tui-workflows.md
- /Users/andrestobelem/.nvm/versions/node/v24.16.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/tui.md

UX propuesta:
${ctx.compact(ux.output, 40_000)}

Entrega:
## Funciones/clases exactas a modificar
## Helpers nuevos necesarios
## Riesgos de ancho/render/invalidation
## Plan MVP en orden
## Pruebas manuales/comandos
Cita rutas y líneas cuando puedas. No edites archivos.`,
    { name: "implementacion-factible", tools: ["read", "grep", "find", "ls"], timeoutMs: agentTimeoutMs },
  );
  await ctx.writeArtifact("implementacion-factible.md", implementation.output);

  const critic = await ctx.agent(
    `Critica el plan para evitar sobreingenieria y bugs.

Patrón: evaluación adversarial. Tu objetivo es reducir scope y prevenir fallos, no ser complaciente.

Contexto codigo:
${ctx.compact(context, 20_000)}

UX:
${ctx.compact(ux.output, 30_000)}

Implementacion:
${ctx.compact(implementation.output, 30_000)}

Entrega:
## Qué NO hacer ahora
## Riesgos top 5
## Criterios de aceptación
## MVP recomendado si solo podemos tocar un archivo
## Señales de que el diseño está sobreingenierizado`,
    { name: "critico-scope", tools: ["read", "grep", "find", "ls"], timeoutMs: agentTimeoutMs },
  );
  await ctx.writeArtifact("critico-scope.md", critic.output);

  const synthesis = await ctx.agent(
    `Sintetiza un plan final de implementacion para mejorar mucho la visualizacion TUI de workflows en Pi.

Patrón: synthesis-as-judge. Elegí una ruta concreta, deduplicá ideas, resolvé contradicciones y marcá riesgos aceptados.

Incluye:
- Vision final.
- MVP que implementaremos ahora.
- Wireframe ASCII.
- Cambios concretos en extensions/dynamic-workflows.ts.
- Docs a actualizar.
- Validaciones.
- Qué queda fuera de scope.

UX:
${ctx.compact(ux.output, 35_000)}

Implementacion:
${ctx.compact(implementation.output, 35_000)}

Critica:
${ctx.compact(critic.output, 25_000)}`,
    { name: "sintesis-plan-final", tools: ["read", "grep", "find", "ls"], timeoutMs: agentTimeoutMs },
  );

  await ctx.writeArtifact("plan-tui-workflows.md", synthesis.output);
  return synthesis.output;
};
