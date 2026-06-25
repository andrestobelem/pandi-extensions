module.exports = async function workflow(ctx, input) {
  const person = input?.person ?? "Andrej Karpathy";
  const question = input?.question ?? "¿Cuáles son las recomendaciones de Andrej Karpathy para programar / aprender programación y usar IA al programar?";
  const language = input?.language ?? "español";
  const agentTimeoutMs = input?.agentTimeoutMs ?? Math.min(ctx.limits.agentTimeoutMs, 300_000);

  await ctx.log("Starting Karpathy programming recommendations web research", { person, question, language });

  const angles = input?.angles ?? [
    {
      name: "primary-sources",
      focus: "Fuentes primarias de Andrej Karpathy: blog, charlas, repositorios, videos, tweets/posts. Buscar recomendaciones explícitas sobre programar, aprender CS, escribir código y trabajar con LLMs."
    },
    {
      name: "learn-to-code",
      focus: "Recomendaciones de Karpathy para aprender programación/CS/ML: proyectos, backprop/nanoGPT, lectura, práctica, debugging, construir desde cero."
    },
    {
      name: "ai-assisted-coding",
      focus: "Recomendaciones recientes de Karpathy sobre programar con IA: vibe coding, Cursor/Claude/GPT, revisión humana, prototipado vs producción, agentes y limitaciones."
    },
    {
      name: "engineering-principles",
      focus: "Principios prácticos de ingeniería atribuidos a Karpathy: simplicidad, claridad, iteración, tests/evaluaciones, datasets, notebooks/scripts, performance, documentación."
    },
    {
      name: "skeptical-verification",
      focus: "Verificar citas y afirmaciones populares: distinguir consejos realmente documentados por Karpathy de interpretaciones de terceros; señalar incertidumbres."
    }
  ];

  const instructions = `Investiga en internet usando web_search. Corrige la grafía "Karphaty" a "Karpathy" si aparece.

Pregunta: ${question}
Persona: ${person}
Idioma de respuesta: ${language}

Patrón de trabajo: fan-out de investigación con verificación escéptica. Tu ángulo debe ser independiente y autocontenido.

Política de fuentes:
- Prioriza fuentes primarias: blog, repos, talks, videos, posts directos de ${person}.
- Acepta fuentes secundarias solo para ubicar una fuente primaria o contextualizar.
- No atribuyas consejos a ${person} sin evidencia.
- Incluye URL y, si aplica, fecha aproximada.

Contrato de salida:
- Bullets con: recomendación → evidencia/URL → cita/paráfrasis breve → confianza Alta/Media/Baja → nota de aplicabilidad.
- Separa cita directa, paráfrasis e interpretación.
- Marca INSUFFICIENT_EVIDENCE cuando no haya respaldo sólido.
- Sé conciso.`;

  const research = await ctx.agents(
    angles.map((angle) => ({
      name: angle.name,
      prompt: `${instructions}

Ángulo de investigación: ${angle.focus}

Busca varias consultas si hace falta, pero prioriza precisión sobre cantidad.`,
      tools: ["web_search"],
      includeExtensions: true,
      timeoutMs: agentTimeoutMs,
    })),
    { concurrency: Math.min(input?.concurrency ?? ctx.limits.concurrency, ctx.limits.concurrency) },
  );

  await ctx.writeArtifact("research.json", research);

  const synthesisPrompt = `Sintetiza los hallazgos en español para el usuario.

Pregunta: ${question}

Patrón de trabajo: synthesis-as-judge. Deduplica, descarta atribuciones sin evidencia, reporta agentes fallidos/timeouts y conserva incertidumbre.

Formato obligatorio:
1. Resumen corto.
2. Lista priorizada de recomendaciones prácticas para programar/aprender/programar con IA.
3. Tabla: recomendación | evidencia primaria | cita/paráfrasis | confianza | cómo aplicarlo.
4. Advertencias: cita directa vs interpretación vs poco verificado.
5. Fuentes con URLs.

Si faltan fuentes primarias, dilo claramente.

Hallazgos de los subagentes:
${ctx.compact(research, 90000)}`;

  const synthesis = await ctx.agent(synthesisPrompt, {
    name: "synthesis",
    tools: ["web_search"],
    includeExtensions: true,
    timeoutMs: agentTimeoutMs,
  });

  await ctx.writeArtifact("synthesis.md", synthesis.output);
  return synthesis.output;
};
