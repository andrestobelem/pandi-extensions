module.exports = async function workflow(ctx, input) {
  const question = input?.question ?? "¿Cuáles son los usos prácticos de los patrones de workflows agénticos?";
  const language = input?.language ?? "español";
  const agentTimeoutMs = input?.agentTimeoutMs ?? Math.min(ctx.limits.agentTimeoutMs, 300_000);

  await ctx.log("Starting agentic workflow patterns research", { question, language });

  const topics = input?.topics ?? [
    {
      name: "pattern-taxonomy",
      focus: "Taxonomía de patrones: prompt chaining, routing, parallelization, orchestrator-workers, evaluator-optimizer, reflection, tool use, planning, multi-agent review. Cuándo conviene cada uno."
    },
    {
      name: "real-world-uses",
      focus: "Usos reales por dominio: coding agents, investigación web, soporte al cliente, análisis de documentos, data/BI, operaciones, QA, seguridad y automatización empresarial."
    },
    {
      name: "design-tradeoffs",
      focus: "Tradeoffs y criterios de diseño: coste, latencia, confiabilidad, evaluación, observabilidad, human-in-the-loop, riesgos y anti-patrones."
    }
  ];

  const basePrompt = `Investiga en internet usando web_search.

Pregunta: ${question}
Idioma de respuesta: ${language}

Patrón de trabajo: fan-out de investigación independiente + síntesis posterior. Tu trabajo debe ser autocontenido; no asumas que otros agentes cubrirán huecos.

Política de fuentes:
- Prioridad 1: fuentes primarias o docs oficiales (Anthropic, OpenAI, LangChain/LangGraph, Microsoft/AutoGen, LlamaIndex).
- Prioridad 2: artículos técnicos con autor/fecha claros.
- Evita marketing genérico o posts sin evidencia.
- Cita URLs concretas en cada hallazgo.

Contrato de salida:
- Entrega 8-12 bullets como: patrón → uso práctico → cuándo usarlo → cuándo evitarlo → fuente/URL → confianza Alta/Media/Baja.
- Distingue workflows determinísticos de agentes más autónomos.
- Incluye al menos 2 anti-patrones o riesgos.
- Si no encontrás evidencia suficiente, escribe INSUFFICIENT_EVIDENCE y explica qué falta.
- Sé conciso para evitar timeouts.`;

  const research = await ctx.agents(
    topics.map((topic) => ({
      name: topic.name,
      prompt: `${basePrompt}

Foco específico: ${topic.focus}

No escribas una introducción larga. Prioriza evidencia accionable y ejemplos reales.`,
      tools: ["web_search"],
      includeExtensions: true,
      timeoutMs: agentTimeoutMs,
    })),
    { concurrency: Math.min(input?.concurrency ?? 3, ctx.limits.concurrency), settle: true },
  );

  // Keep only the useful assistant text per topic. The full result objects also carry the
  // raw streaming `stdout` (~230KB each), which would blow the synthesis budget and starve
  // it down to a single topic. Persist clean findings (synthesis input) + raw (debugging).
  const findings = research.map((r, i) => ({
    name: topics[i]?.name ?? `topic-${i + 1}`,
    ok: !!(r && r.ok !== false && (r.code === undefined || r.code === 0) && r.output),
    output: r && r.output ? r.output : "(sin salida)",
  }));
  const okFindings = findings.filter((f) => f.ok);
  const failedNames = findings.filter((f) => !f.ok).map((f) => f.name);
  await ctx.writeArtifact("research.json", findings);
  await ctx.writeArtifact("research-raw.json", research);
  await ctx.log("research fan-out complete", { topics: findings.length, ok: okFindings.length, failed: failedNames.length, failedNames });

  const synthesis = await ctx.agent(
    `Sintetiza en español los resultados en una guía práctica.

Pregunta: ${question}

Patrón de trabajo: synthesis-as-judge. No hagas promedio de opiniones: deduplica, descarta afirmaciones sin fuente, marca resultados parciales/fallidos y conserva incertidumbre.

Cobertura de research: ${okFindings.length}/${findings.length} subagentes con contenido útil.${failedNames.length ? ` Fallidos/sin salida (NO inventes su contenido): ${failedNames.join(", ")}.` : ""}

Formato obligatorio:
1. Resumen ejecutivo en 5 bullets.
2. Tabla: patrón agéntico | mejores usos | cuándo evitarlo | ejemplo concreto | confianza | fuentes.
3. Guía de selección rápida: si la tarea es X, usar Y.
4. Anti-patrones y riesgos de coste/latencia/confiabilidad.
5. Cómo aplicar estos patrones a workflows dinámicos de Pi.
6. Fuentes principales con URLs.

Resultados de subagentes (solo los que tienen contenido; declara la cobertura parcial si la hay):
${ctx.compact(okFindings, 200000)}`,
    {
      name: "synthesis",
      tools: ["web_search"],
      includeExtensions: true,
      timeoutMs: agentTimeoutMs,
    },
  );

  await ctx.writeArtifact("synthesis.md", synthesis.output);
  return synthesis.output;
};
