module.exports = async function workflow(ctx, input) {
  const agentTimeoutMs = input?.agentTimeoutMs ?? ctx.limits.agentTimeoutMs;
  await ctx.log("Planning background workflow implementation", { input });

  const sharedContract = `
Patrón de trabajo: revisión paralela independiente + síntesis posterior.
Reglas:
- No edites archivos.
- Usa solo evidencia del repositorio.
- Cita rutas y líneas o nombres de funciones cuando hagas afirmaciones concretas.
- Separa hechos confirmados, riesgos y suposiciones.
- Propón el cambio mínimo seguro antes de mejoras grandes.
Formato:
## Veredicto
## Hallazgos / decisiones recomendadas
## Riesgos y mitigaciones
## Cambios concretos
## Criterios de aceptación`;

  const prompts = [
    {
      name: "engine-design",
      prompt: `Inspect extensions/dynamic-workflows.ts and propose a minimal, robust design to support background workflow runs.

Focus: runWorkflow/runWorkflowWithUi, run ids, abort signals, result/status files, in-memory active runs, stale detection.
${sharedContract}`,
    },
    {
      name: "tool-command-ui",
      prompt: `Inspect extensions/dynamic-workflows.ts and README.md.

Focus: dynamic_workflow tool schema/handleTool, /workflow commands, dashboard/runs/view output, docs and user-facing wording for background workflow runs.
${sharedContract}`,
    },
    {
      name: "risk-review",
      prompt: `Inspect extensions/dynamic-workflows.ts for risks when detaching workflow execution from a tool call.

Focus: signal lifetime, process/session shutdown, unhandled rejections, UI widget ownership, active run visibility, cancellation semantics, cost surprises.
${sharedContract}`,
    }
  ];

  const reviews = await ctx.agents(
    prompts.map((item) => ({ ...item, tools: ["read", "grep", "find", "ls"], timeoutMs: agentTimeoutMs })),
    { concurrency: Math.min(input?.concurrency ?? 3, ctx.limits.concurrency) },
  );

  await ctx.writeArtifact("reviews.json", reviews);

  const synthesis = await ctx.agent(
    `Synthesize an implementation checklist for background workflow runs.

Patrón de trabajo: synthesis-as-judge. Deduplica, resuelve contradicciones, conserva riesgos aceptados y prioriza un patch pequeño.

Formato obligatorio:
1. Objetivo y alcance.
2. Plan por pasos con funciones/interfaces exactas a tocar.
3. Cambios mínimos vs mejoras posteriores.
4. Riesgos top con mitigación.
5. Criterios de aceptación.
6. Comandos/pruebas manuales.

Reviews:
${ctx.compact(reviews, 70000)}`,
    { name: "synthesis", tools: ["read", "grep", "find", "ls"], timeoutMs: agentTimeoutMs },
  );

  await ctx.writeArtifact("plan.md", synthesis.output);
  return synthesis.output;
};
