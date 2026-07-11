---
type: "Research Note"
title: "Context Engineering: mantener enfocado un LLM y su harness de agentes"
description: "Investigación respaldada por fuentes sobre cómo mantener enfocado a un LLM y su harness de agentes."
tags: [context-engineering, agents, llm, evidence]
timestamp: 2026-06-28T00:00:00Z
---

# Context Engineering: mantener enfocado un LLM y su harness de agentes

> **Estado: FINAL.** Revisión hecha para incorporar feedback externo. Las cifras autoinformadas o de proveedor, y los
> desacuerdos, están marcados como `[UNVERIFIED]` o `[CONTESTED]`. Cuando el borrador original citaba IDs de arXiv
> imposibles de verificar (por ser futuros), esos números se quitaron. El “acuerdo de research-branch” interno se
> reemplazó por conteos de fuentes externas distintas. También se agregaron vacíos de cobertura señalados por la
> revisión (prompt compression, extensión de contexto a nivel de modelo, defensas contra inyección, RAG avanzado,
> evacuación de KV-cache, amplitud de evaluaciones) con fuentes verificadas. Ver **§8 Confidence & caveats**.

---

## 1. Resumen ejecutivo

**Context engineering es la disciplina de curar _todos_ los tokens que ve un modelo.** Eso incluye system prompt,
definiciones de tools, historial de mensajes, datos recuperados y estado del entorno; todo reducido al conjunto mínimo
de alta señal, en vez de intentar meter todo en una ventana grande (Anthropic, "Effective context engineering for AI
agents," Sep 29 2025 — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).

**La relectura central:** el contexto es un “presupuesto de atención” finito, no un balde.

**Empíricamente, la recuperación y la confiabilidad del razonamiento se degradan cuando crece la longitud de entrada** —
fenómeno que suele llamarse “context rot” — aun cuando la tarea se mantiene constante. El mecanismo preciso se debate
(ver §2). La complejidad O(n²) de self-attention suele usarse como intuición de por qué los contextos largos son más
difíciles, pero eso es una propiedad de _costo_ de attention, no una causa establecida de pérdida de recall; tómese como
metáfora, no como mecanismo.

**Por qué se pierde el foco (la línea común en la evidencia):**

- **Sesgo posicional.** Los modelos atienden mejor al _inicio y al final_ del contexto y peor al _medio_ — una curva en
  U ("Lost in the Middle," Liu et al., TACL 2024 — https://arxiv.org/abs/2307.03172). El efecto posicional también
  aparece en RULER, NoLiMa y el estudio Context Rot de Chroma.
- **Caída por longitud.** La confiabilidad baja a medida que crece la entrada cruda, incluso en tareas triviales, en 18
  modelos (GPT-4.1, Claude 4, Gemini 2.5, variantes de Qwen3, etc.) (Chroma "Context Rot," Jul 14 2025 —
  https://www.trychroma.com/research/context-rot). Esto coincide con NoLiMa, RULER y "Context Length Alone Hurts…".
- **Distracción.** Tokens irrelevantes pero similares — incluso una sola oración off-topic — desvían la atención de la
  tarea (Shi et al., GSM-IC — https://arxiv.org/abs/2302.00093).

**Consecuencia práctica:** mantené el contexto de trabajo pequeño y de alta señal, poné el material crítico en los
bordes, recuperá just-in-time, aislá el ruido y medí el foco a longitudes realistas en lugar de confiar en ventanas
“advertised”.

---

## 2. Cómo falla el foco (mecanismos)

| Mecanismo                                                                     | Qué pasa                                                                                                                                                                                                                                                                      | Evidencia principal                                                                                              |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Lost in the middle (sesgo posicional)**                                     | La precisión en QA multi-doc y key-value retrieval es más alta cuando la evidencia está al principio o al final, cae “significantly” en el medio — a veces por debajo del baseline closed-book; las variantes long-context no fueron consistentemente mejores.                | Liu et al. — https://arxiv.org/abs/2307.03172 / https://aclanthology.org/2024.tacl-1.9/                          |
| **Context rot (caída por longitud)**                                          | El rendimiento “becomes less reliable as input length grows”, incluso en tareas controladas, en GPT-4.1, Claude 4, Gemini 2.5 y variantes de Qwen3. En LongMemEval, prompts completos de ~113k tokens rindieron _peor_ que prompts enfocados de ~300 tokens.                  | Chroma — https://www.trychroma.com/research/context-rot                                                          |
| **Longitud efectiva ≪ ventana publicitada**                                   | La “effective length” de RULER (threshold ≈ Llama-2-7B@4K, 85.6% en 13 tareas) muestra que muchos modelos quedan por debajo de su ventana declarada; el NIAH vanilla puede “hide major degradation”.                                                                          | RULER, Hsieh et al. — https://arxiv.org/abs/2404.06654                                                           |
| **Colapso de recuperación latente (no lexical)**                              | Cuando se elimina el solapamiento léxico entre pregunta y needle, 10–11 de ~13 modelos long-context caen por debajo del 50% del baseline short-context a 32K; GPT-4o pasa de 99.3% a 69.7%.                                                                                   | NoLiMa, Modarressi et al., ICML 2025 — https://arxiv.org/abs/2502.05167                                          |
| **Distracción por contexto irrelevante**                                      | Una sola oración irrelevante bajó CoT en code-davinci-002 de 95% a 72.4%; el solapamiento léxico/de entidad con el distractor pesó más que la magnitud. Self-consistency (20 samples) recuperó a 88.1%.                                                                       | Shi et al., GSM-IC — https://arxiv.org/abs/2302.00093                                                            |
| **Distracción de contexto en RAG**                                            | La calidad de respuesta sube y luego _cae_ a medida que aumentan los chunks recuperados; la caída tardía se atribuye a hard negatives recuperados. Incluso un distractor baja el rendimiento; cuatro lo agravan.                                                              | OP-RAG — https://arxiv.org/abs/2409.01666; “LC LLMs Meet RAG” — https://arxiv.org/abs/2410.05983; Chroma (ibid.) |
| **La longitud perjudica incluso con recuperación perfecta**                   | La degradación aparece al crecer la entrada _aunque toda la información relevante esté presente_ — el pruning es una palanca de foco independiente del recall.                                                                                                                | “Context Length Alone Hurts…” — https://arxiv.org/abs/2510.05381 `[UNVERIFIED magnitude — summary only]`         |
| **Attention sinks / recency**                                                 | Los modelos autoregresivos concentran mucha atención en los primeros ~4 tokens, sin importar el significado (artifact de softmax); si se los expulsa, la fluidez colapsa. Explica por qué el _inicio_ de contexto dirige tanto y por qué los sliding windows ingenuos fallan. | StreamingLLM, Xiao et al. — https://arxiv.org/abs/2309.17453                                                     |
| **La obediencia a instrucciones cae con la longitud (distinta de retrieval)** | La mayoría de los modelos obedecen menos las instrucciones al crecer la entrada, sobre todo después de 16k/32k tokens, y también empeora la estabilidad; es algo separable de “si recuperó o no”.                                                                             | LIFBench, ACL 2025 — https://aclanthology.org/2025.acl-long.803/; IFEval — https://arxiv.org/abs/2311.07911      |
| **Self-mimicry / drift few-shot**                                             | Un historial demasiado uniforme o repetitivo hace que el modelo imite su propio patrón pasado en vez de razonar sobre el estado actual.                                                                                                                                       | Manus — https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus                      |

**Caveat mecanismo vs. medición `[CONTESTED/INTERPRETED]`.** Context rot, lost-in-the-middle y NoLiMa _miden_
degradación. La causa subyacente — ya sea positional encoding, attention dilution o softmax mass allocation — se infiere
parcialmente. StreamingLLM ofrece el relato mecánico más directo, pero explica streaming/eviction, no toda la pérdida en
el medio del contexto. Sigue abierto si el comportamiento de attention sinks y la negligencia del medio son el mismo
fenómeno.

**Mitigación a nivel de modelo (extensión de contexto).** Parte de la caída por longitud es un artifact de la longitud
de entrenamiento: los modelos basados en RoPE extrapolan mal más allá de su ventana entrenada. **Position
Interpolation** (Chen et al. — https://arxiv.org/abs/2306.15595) y **YaRN** (Peng et al. —
https://arxiv.org/abs/2309.00071) reescalan rotary position embeddings para extender la ventana usable con fine-tuning
modesto. Cuidado: esto extiende la longitud _entrenada_ y reduce fallos de extrapolación, pero no elimina por sí solo
lost-in-the-middle ni la degradación de context-rot. La longitud efectiva sigue por debajo de la ventana extendida
(RULER).

---

## 3. Técnicas por capa

### 3a. Construcción de contexto (prompt/system, placement, estructura, señal/ruido)

- **Diseño sensible a la posición.** Poné el material crítico para la tarea (instrucciones, la pregunta real, el único
  documento más relevante) al **inicio y/o al final**, nunca enterrado en el medio del contexto — contrarresta
  directamente la U-shape (Liu et al.). Anclar directivas durables en los _primeros tokens_ también aprovecha la
  estructura de attention sink (StreamingLLM).
- **Instructions-first vs. query-at-end `[CONTESTED — reconcilable]`.** Guía de OpenAI: poner instrucciones al
  _comienzo_ (https://help.openai.com/en/articles/6654000-best-practices-for-prompt-engineering-with-the-openai-api).
  Guía de Anthropic para 20k+ tokens: poner documentos grandes arriba y la consulta al _final_, reportando hasta
  **+30%** de calidad de respuesta `[UNVERIFIED — Anthropic internal tests]`
  (https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices). Ambos
  explotan primacy/recency; la elección correcta depende de la longitud y debería probarse con A/B (prompt corto →
  instructions-first; documento muy largo → query-at-end).
- **Delimitadores / estructura explícita.** Tags XML o Markdown (`<instructions>`, `<context>`, `<examples>`, `<input>`,
  `<documents>`) ayudan a que el modelo distinga comandos, referencia y entrada de usuario (Anthropic, OpenAI prompt
  guides). Anthropic aclara que esto es un _apoyo a la confiabilidad_, no un validador duro.
- **Separación de autoridad (seguridad + estabilidad).** El comportamiento durable vive en los canales `system` /
  `developer`. **Nunca pongas contenido no confiable recuperado por tools allí** (Anthropic mid-conversation system
  messages — https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages; OpenAI prompt
  engineering guide).
- **Defensas contra prompt injection más allá de la separación de autoridad.** Los delimitadores _no_ son una frontera
  de seguridad. **Spotlighting** (Hines et al., Microsoft — https://arxiv.org/abs/2403.14720) agrega marcación más
  fuerte de datos: _delimiting_, _datamarking_ (intercalar una marca especial a lo largo del texto no confiable) y
  _encoding_ (por ejemplo, base64), y reporta bajar el éxito de ataques de >50% a <2% `[author-reported]`. Un benchmark
  de seguimiento de 2026 encontró que la eficacia es **dependiente del modelo** e insuficiente frente a inyecciones
  camufladas por dominio (https://arxiv.org/abs/2606.18530) — usalo como defensa en profundidad, no como garantía.
- **Paso de extracción de citas.** Pedile al modelo que extraiga citas relevantes _antes_ de responder tareas sobre
  documentos largos — fuerza el estrechamiento de atención hacia spans concretos (Anthropic best-practices &
  reduce-hallucinations docs).
- **Structured Outputs (JSON Schema).** Preferí schema strict-mode antes que “please output JSON” para eliminar drift de
  formato (OpenAI Structured Outputs — https://developers.openai.com/api/docs/guides/structured-outputs).
- **Few-shot es un arma de doble filo `[CONTESTED]`.** Los ejemplos ayudan cuando zero-shot no alcanza, pero **el orden
  solo puede mover la precisión de azar a casi SOTA** (Lu et al., “Fantastically Ordered Prompts” —
  https://aclanthology.org/2022.acl-long.556/). La calibración mejoró GPT-3 hasta 30 puntos (Zhao et al., “Calibrate
  Before Use” — https://arxiv.org/abs/2102.09690). Default: **empezar zero-shot**, sumar un conjunto pequeño y diverso
  solo si hace falta, y validar barajando. La evidencia de calibración es más fuerte para clasificación; su
  transferencia a coding agentic es `[UNVERIFIED]`.
- **Reasoning models:** mantené prompts simples y directos, usá delimitadores, zero-shot primero, y evitá forzar
  chain-of-thought (OpenAI reasoning best practices).
- **“Ignore irrelevant information” explícito + pruning agresivo** restauró robustez de forma medible en tests de
  distracción (Shi et al., GSM-IC).

### 3b. Gestión de la ventana de contexto (compaction, offloading, memory, caching)

La taxonomía de LangChain **write / select / compress / isolate** organiza todas las palancas (Lance Martin —
https://rlancemartin.github.io/2025/06/23/context_engineering/;
https://www.langchain.com/blog/context-engineering-for-agents):

- **Compaction.** Resumí el historial acumulado en un nuevo bloque de contexto cerca del umbral de tokens. Claude ofrece
  _server-side_ automatic compaction con instrucciones personalizadas de resumen
  (https://platform.claude.com/docs/en/build-with-claude/compaction).
- **La compaction es con pérdida y se acumula.** Las capas recursivas de resumen pueden borrar hechos que después
  necesitás. El estudio de resumen de libros de Wu et al. encontró que solo ~5% de los resúmenes llegó a calidad cercana
  a la humana (https://arxiv.org/abs/2109.10862) — esto caracteriza _summarization_, no compaction específicamente. Tomá
  la compaction multinivel como un **riesgo de error en cascada** y preservá artifacts crudos fuera del contexto para
  que la compaction sea recuperable, no destructiva.
- **Prompt compression.** **LLMLingua / LongLLMLingua** (Jiang et al., Microsoft — https://arxiv.org/abs/2310.05736,
  https://arxiv.org/abs/2310.06839) usan un LM pequeño para descartar tokens de baja información. Reportan compresión
  múltiple con pérdida de calidad limitada y, en LongLLMLingua, menor sesgo posicional en contextos largos
  `[author-reported figures]`. Útil cuando historial o recuperaciones verbosas deben quedarse en ventana; es con
  pérdida, así que validalo en tu tarea.
- **Limpieza de tool results / context editing.** Eliminá outputs verbosos de tools una vez consumidos, conservando la
  _decisión_ pero no el payload (Anthropic context management — https://claude.com/blog/context-management; cookbook —
  https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools).
- **Filesystem / memoria externa.** Escribí observaciones grandes a archivos; mantené solo referencias o paths en
  ventana y releelas on demand. **MemGPT** trata la ventana como la memoria principal de un SO, paginando entre contexto
  y store externo mediante function calls (Packer et al. — https://arxiv.org/abs/2310.08560). La **Memory tool** de
  Anthropic hace esto entre sesiones (https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool).
- **Resumen recursivo / jerárquico.** Resumí chunks, y luego resumí los resúmenes (OpenAI “Recursively Summarizing
  Books,” Wu et al. — https://arxiv.org/abs/2109.10862).
- **Taxonomía de memoria.** CoALA: working + episodic + semantic + procedural memory
  (https://arxiv.org/html/2309.02427v3). Generative Agents recupera por **relevance/recency/importance** con
  consolidación vía reflection (https://arxiv.org/abs/2304.03442). LangGraph separa scratchpads por thread
  (checkpointers) de stores cross-thread (https://docs.langchain.com/oss/python/langgraph/add-memory).
- **Prompt caching.** Ordená el contenido `tools → system → messages`; mantené estable el contenido primero y el volátil
  al final; usá ≤4 breakpoints. Anthropic reporta hasta **~90% cost / ~85% latency reduction** para prompts largos
  `[UNVERIFIED — vendor-reported, favorable conditions]`
  (https://platform.claude.com/docs/en/build-with-claude/prompt-caching; https://claude.com/blog/prompt-caching).

### 3c. Retrieval y contexto just-in-time (RAG vs JIT, búsqueda agentic)

- **Just-in-time antes que preload.** Mantené referencias livianas (paths, query IDs, links); cargá el contenido en
  runtime con `glob` / `grep` / `head` / `tail`. Cambia latencia por “less context pollution and better focus”
  (Anthropic effective-context-engineering).
- **Limitá la profundidad de retrieval.** No vuelques top-50; encontrá el sweet spot de OP-RAG (a menudo k moderado)
  para tu dataset (https://arxiv.org/abs/2409.01666).
- **Rerank cuando importa la precisión y la latencia lo permite.** Recuperá amplio (BM25 + dense), fusioná con RRF y
  después aplicá un cross-encoder reranker a los candidatos top. El reranking suele ser una de las mayores mejoras de
  precisión en retrieval pipelines, pero los cross-encoders agregan latencia/costo y no siempre valen la pena (BEIR
  benchmark suite — https://arxiv.org/abs/2104.08663; SBERT retrieve-rerank docs). El ablation de Anthropic Contextual
  Retrieval muestra que reranking suma sobre contextual embeddings + BM25
  (https://www.anthropic.com/engineering/contextual-retrieval).
- **Híbrido lexical + dense, no dense-only.** BM25 sigue siendo clave para identificadores exactos, términos raros/de
  dominio, códigos de error y nombres de símbolos — crítico en harnesses de coding (BEIR benchmark suite —
  https://arxiv.org/abs/2104.08663; SBERT retrieve-rerank docs).
- **Contextual Retrieval.** Agregá una breve descripción situacional a cada chunk antes de embedder/BM25. Anthropic
  reporta reducciones en la tasa de _failure_ top-20: 5.7% → 3.7% (contextual embeddings) → 2.9% (+contextual BM25) →
  1.9% (+reranking, ~67% relative reduction) `[vendor-reported]`
  (https://www.anthropic.com/engineering/contextual-retrieval).
- **Patrones de RAG del lado de la query y del grafo** (más allá de híbrido + rerank):
  - **HyDE** genera un documento hipotético de respuesta y lo embeddea para retrieval denso zero-shot (Gao et al. —
    https://arxiv.org/abs/2212.10496).
  - **Query decomposition / rewriting** separa preguntas complejas en subqueries antes de recuperar (palanca estándar
    para multi-hop recall; no existe una única fuente canónica).
  - **Self-RAG** entrena al modelo para recuperar on demand y criticar pasajes vía reflection tokens (Asai et al. —
    https://arxiv.org/abs/2310.11511); **Corrective RAG (CRAG)** agrega un evaluador de calidad de retrieval que dispara
    web search / filtering correctivo (Yan et al. — https://arxiv.org/abs/2401.15884).
  - **GraphRAG** construye un grafo de entidades + resúmenes de comunidades para preguntas globales a nivel corpus (Edge
    et al., Microsoft — https://arxiv.org/abs/2404.16130).
  - **Late chunking** embeddea primero el documento completo y después hace pooling por chunk, preservando contexto
    entre chunks (Günther et al., Jina — https://arxiv.org/abs/2409.04701).
  - **Reordená los docs recuperados hacia los bordes.** Poné los chunks más fuertes al inicio y al final del bloque
    recuperado para contrarrestar lost-in-the-middle (Liu et al.).
- **Enrutá LC vs RAG por tipo de consulta/costo `[CONTESTED — no universal winner]`.** LC suele superar a RAG en QA,
  pero RAG ayuda en diálogo/consultas generales (Li et al. — https://arxiv.org/abs/2501.01880). Self-Route enruta barato
  a RAG y solo escala a LC cuando hace falta (https://arxiv.org/abs/2407.16833). Solo modelos SOTA recientes sostienen
  precisión más allá de 64K tokens (https://arxiv.org/abs/2411.03538).
- **Filesystem search agentic vs vector RAG = tradeoff de escala.** Filesystem search gana en corpus _pequeños_ (docs
  completos caben en contexto); RAG es más rápido y escala mejor a 100–1000 docs (LlamaIndex, Jan 13 2026 —
  https://www.llamaindex.ai/blog/did-filesystem-tools-kill-vector-search).
- **Evaluá retrieval con distractores realistas + needles no léxicos**, no con NIAH literal (NoLiMa, Context Rot).

> _Eliminado del borrador:_ cifras de reranking en finanzas específicas (por ejemplo, Recall@5 / MRR@5) que rastreaban
> citas con IDs de arXiv futuros e imposibles de resolver.

### 3d. Arquitectura de harness y agentes (presupuesto de tools, sub-agents, aislamiento, orquestación)

**El debate arquitectónico central `[CONTESTED — reconcilable]`:**

- **Cognition: por defecto, agentes single-threaded y lineales con un trace continuo**
  (https://cognition.com/blog/dont-build-multi-agents). Dos principios: (a) _compartir traces completos del agente, no
  mensajes aislados_; (b) _las acciones llevan decisiones implícitas_. El fan-out ingenuo deriva porque un subagent que
  recibe solo un mensaje de subtarea no tiene el razonamiento que lo produjo y vuelve a decidir de forma divergente. Su
  actualización de 2026 permite multi-agent _solo cuando las writes quedan single-threaded_ y los agentes auxiliares son
  read-only (https://cognition.com/blog/multi-agents-working).
- **Anthropic: subagents orquestador-worker como filtros paralelos de compresión de contexto** — cada uno corre con una
  ventana limpia, explora breadth-first y devuelve solo hallazgos condensados
  (https://www.anthropic.com/engineering/multi-agent-research-system). Reporta **+90.2% sobre single-agent Opus 4** en
  una evaluación interna de research. **Caveat de costo (corregido):** Anthropic también reporta que las corridas
  multi-agent consumen **~15× tokens de una interacción típica de _chat_** (los agentes solos son ~4× chat); el
  multiplicador _respecto del baseline single-agent que produjo la mejora de 90.2%_ no está indicado en la fuente.
  `[UNVERIFIED — Anthropic internal eval; unlikely to transfer to coding/editing.]`

**Reconciliación:** _Aislar para leer/explorar_ (trabajo independiente, paralelizable, read-heavy); _single-thread para
escribir/decidir_ (estado compartido, mutación interdependiente — coding típico). Hacé que la arquitectura siga la
topología de la tarea, no la moda.

**Presupuesto de tools (evidencia fuerte, multifuente):**

- **Las superficies planas grandes de tools degradan el rendimiento.** LongFuncEval: la precisión de tool-calling cae
  **7%–85%** a medida que sube la cantidad de tools; la recuperación de respuesta cae **7%–91%** cuando crece la
  longitud de las respuestas de tools (https://arxiv.org/abs/2505.10570).
- **Recuperá una shortlist de tools específica para la tarea.** RAG-MCP: **>50% de reducción de tokens del prompt**,
  precisión de selección de tools **43.13% vs 13.62%** baseline (https://arxiv.org/abs/2505.03275). Cuidado: los
  retrievers genéricos de IR rinden peor para tool retrieval (ToolRet — https://arxiv.org/abs/2503.01763), así que medí
  la calidad del retrieval.
- **Descubrimiento de tools on-demand.** Anthropic Tool Search mantiene un search tool + 3–5 tools comunes, y reporta
  **~85% token reduction**; los setups grandes de MCP multi-server desperdician **~55k tokens** antes de hacer trabajo
  útil (https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool).
- **Construí menos tools, más orientadas al workflow y no superpuestas**, con namespacing y salidas eficientes en tokens
  (https://www.anthropic.com/engineering/writing-tools-for-agents).
- **Contrato de delegación explícito** para cada subagent: objetivo, formato de salida, tools/sources permitidos,
  límites de tarea (Anthropic multi-agent).
- **Allowlists de tools acotadas / middleware de selección dinámica** restringen tools por rol/etapa/permisos (LangChain
  Deep Agents — https://docs.langchain.com/oss/python/deepagents/context-engineering)
  `[line-level Claude Code --allowedTools behavior UNVERIFIED]`.

### 3e. Steering y control de atención

- **Recitation / re-anchoring.** Mantené y reescribí un plan `todo.md` en cada paso para empujar el objetivo a la zona
  de recencia de alta atención (Manus —
  https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus). Los gains se reportan _solo
  cualitativamente_; no hay ablation controlada `[UNVERIFIED magnitude]`.
- **KV-cache stable prefix.** Mantené prefijos de prompt estables y contexto append-only; evitá timestamps o no
  determinismo temprano; usá breakpoints explícitos (Manus; Anthropic prompt-caching).
- **Tool masking en lugar de tool removal.** Limitá la disponibilidad mediante logit masking / response prefill / una
  state machine en vez de editar el roster de tools (Manus).
- **Mantené errores / acciones fallidas / stack traces en contexto.** Preservar fallos actualiza las “beliefs” del
  modelo y lo orienta a no repetir errores (Manus).
- **Inyectá variación controlada** en historiales repetitivos para evitar self-mimicry few-shot drift (Manus).
- **Conservá los tokens de attention sink al truncar/streaming** (~4 iniciales + ventana reciente) en vez de un
  sliding-window eviction ingenuo (StreamingLLM). Cuidado: esto estabiliza la generación pero no expande la ventana real
  ni recupera contenido expulsado.
- **KV-cache eviction** (nivel research, interno del modelo). Más allá de la retención de sink de StreamingLLM, las
  políticas de eviction mantienen un cache acotado puntuando la importancia de tokens: **Scissorhands**
  (persistence-of-importance — https://arxiv.org/abs/2305.17118), **H2O** (heavy-hitter oracle —
  https://arxiv.org/abs/2306.14048) y **SnapKV** (ventana de observación al final del prompt —
  https://arxiv.org/abs/2404.14469). Reducen memoria/latencia pero, igual que StreamingLLM, _gestionan_ el cache en
  lugar de ampliar la ventana real o recuperar contenido expulsado.
- **Attention steering en inferencia** (research-grade):
  - **PASTA** repondera un subconjunto pequeño de heads de attention hacia spans marcados por el usuario, sin cambiar
    pesos, y reporta ~22% de mejora promedio de accuracy para LLaMA-7B en cuatro tareas `[unchecked figure]`
    (https://arxiv.org/abs/2311.02262).
  - **AutoPASTA** identifica automáticamente el contexto clave a enfatizar; +7.95% promedio para Llama3-70B-Instruct en
    open-book QA `[unchecked figure]` (https://arxiv.org/abs/2409.10790).
  - **Activation steering** mediante instruction vectors agregados al residual stream impone restricciones de formato /
    longitud / inclusión de palabras (Stolfo et al. — https://arxiv.org/abs/2410.12877).
- **Self-consistency sampling** diluye errores inducidos por distracción (GSM-IC: 72.4% → 88.1% con 20 samples).

---

## 4. Evaluar y observar el foco

**Benchmarks (offline):**

| Qué mide                                | Benchmark                                                                                      | Fuente                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Longitud efectiva vs ventana declarada  | **RULER** (13 tipos de tarea; threshold ≈85.6%)                                                | https://arxiv.org/abs/2404.06654 / https://github.com/NVIDIA/RULER               |
| Caída por longitud, distractores        | **Context Rot** (18 modelos; sweep de longitud, dificultad fija)                               | https://www.trychroma.com/research/context-rot                                   |
| Sensibilidad posicional                 | **Lost in the Middle** (multi-needle / position-swept)                                         | https://arxiv.org/abs/2307.03172                                                 |
| Recuperación no léxica                  | **NoLiMa** (usalo como acceptance gate; NIAH vanilla = smoke test solo)                        | https://arxiv.org/abs/2502.05167                                                 |
| Seguir instrucciones bajo longitud      | **IFEval** + **LIFBench** (separa “obedeció reglas” de “recuperó”)                             | https://arxiv.org/abs/2311.07911 / https://aclanthology.org/2025.acl-long.803/   |
| Razonamiento realista de largo contexto | **LongBench v2** (503 MCQs; expertos 53.7%, mejor modelo 50.1%, o1-preview 57.7%)              | https://arxiv.org/abs/2412.15204                                                 |
| Trayectoria de agente + estado final    | **τ-bench** (`pass^k`, grading de estado final), **TRAJECT-Bench** (tool selection/args/order) | https://openreview.net/forum?id=roNSXZpUDN / https://arxiv.org/html/2510.04550v2 |

**Observabilidad (online):**

- **OpenTelemetry GenAI spans** definen un vocabulario estándar: `invoke_agent` (padre) → hijos `chat` (LLM) y
  `execute_tool`, además de `plan` e `invoke_workflow`. Graficá crecimiento de tokens por paso, tasa de errores de tools
  y retries para ver cómo el foco se degrada en vivo
  (https://github.com/open-telemetry/semantic-conventions-genai/tree/main/docs/gen-ai-agent-spans.md). El estado sigue
  siendo “Development”; la captura de contenido (prompts/args) es opt-in.
- **Reportá modelo + harness juntos, con traces/costo/validador logueados** — la configuración del harness cambia
  materialmente los scores (HAL — https://github.com/princeton-pli/hal-harness).

**Receta de evaluación (branch 7):** corré RULER en tu longitud objetivo para encontrar el cliff, después acotá la
entrada por debajo de ese punto → re-test con longitudes realistas, needles no léxicos estilo NoLiMa y distractores →
agregá checks estilo IFEval para restricciones → calificá trajectories (no solo respuestas finales) → emití spans OTel →
fijá/versioná el harness.

---

## 5. Playbook práctico / guía de decisión

**Defaults (alta confianza — corroborados por ≥2 branches):**

1. **Tratá el contexto como un presupuesto escaso de atención.** Curá el conjunto mínimo de alta señal; empezá por lo
   mínimo y agregá solo lo necesario.
2. **Poné instrucciones/evidencia críticas en los bordes (inicio y final), nunca en el medio.**
3. **Presupuestá según la _longitud efectiva_ medida (RULER), no según la ventana declarada.**
4. **Recuperá just-in-time** (referencias + carga on demand) en vez de pre-cargar.
5. **Limitá la profundidad de retrieval y siempre rerankeá**; usá híbrido lexical+dense.
6. **Por defecto usá un agente lineal single-threaded** para trabajo interdependiente/de coding; **aislá subagents solo
   para exploración paralela y read-heavy** (y aceptá el costo de tokens).
7. **Mantené un toolset core pequeño y no superpuesto (≈3–5) + tool search**; devolvé salidas eficientes en tokens.
8. **Gestioná la ventana** con compaction, limpieza de tool results y memoria externa a medida que las corridas se
   alargan.
9. **Re-anclá el objetivo** (recitation/`todo.md`) y **mantené un prefijo de cache estable**; masked tools en lugar de
   remover tools.
10. **Medí el foco** con needles no léxicos + distractores y scoring de trayectorias; trazá con OTel.

**Referencia rápida de decisión:**

| Situación                             | Recomendación                                                  |
| ------------------------------------- | -------------------------------------------------------------- |
| Documento largo (20k+)                | Documentos arriba, query al final; paso de extracción de citas |
| Prompt corto                          | Instructions-first                                             |
| Repo / corpus grande                  | JIT/agentic search (pequeño) o RAG (escala); híbrido + rerank  |
| Investigación paralela, read-only     | Subagents orquestador-worker con contratos explícitos          |
| Ediciones / coding interdependientes  | Un solo trace continuo + compaction                            |
| Librería grande de tools / MCP        | Core toolset + tool search/retrieval                           |
| Loop largo de agente acumulando ruido | Tool-result clearing + memoria externa + recitation            |

**Anti-patterns (evidencia respaldada):**

- Confiar en una ventana grande “advertised” como si implicara atención uniforme (RULER, Context Rot).
- Volcar todos los chunks recuperados / todos los schemas de tools (OP-RAG distraction; LongFuncEval).
- Enterrar instrucciones en el medio (Lost in the Middle).
- Poner contenido no confiable recuperado por tools en el canal system (injection / authority drift).
- Borrar errores del contexto (elimina señal de recuperación — Manus).
- Mutar definiciones de tools en medio del loop (rompe cache, deja referencias colgando — Manus).
- Naive sliding-window KV eviction que descarta tokens sink (StreamingLLM).
- Usar NIAH single-needle vanilla como única evaluación de largo contexto — oculta degradación real; gateá con needles
  no léxicos estilo NoLiMa + RULER (NoLiMa, RULER, Context Rot).

---

## 6. Evidencia y fuentes (consolidado)

Fuentes deduplicadas y agrupadas por tema. Las cifras autoinformadas o de proveedor están marcadas `[UNVERIFIED]` en el
texto.

### Modos de falla y mecanismos

- Lost in the Middle — Liu et al., TACL 2024 — https://arxiv.org/abs/2307.03172
- Context Rot — Chroma, 2025 — https://www.trychroma.com/research/context-rot
- RULER — Hsieh et al. — https://arxiv.org/abs/2404.06654 · https://github.com/NVIDIA/RULER
- NoLiMa — Modarressi et al., ICML 2025 — https://arxiv.org/abs/2502.05167
- Distraction (GSM-IC) — Shi et al. — https://arxiv.org/abs/2302.00093
- OP-RAG — https://arxiv.org/abs/2409.01666 · LC LLMs Meet RAG — https://arxiv.org/abs/2410.05983 · Context length alone
  hurts — https://arxiv.org/abs/2510.05381
- StreamingLLM / attention sinks — Xiao et al. — https://arxiv.org/abs/2309.17453
- LIFBench — https://aclanthology.org/2025.acl-long.803/ · IFEval — https://arxiv.org/abs/2311.07911

### Extensión de contexto a nivel de modelo

- Position Interpolation — Chen et al. — https://arxiv.org/abs/2306.15595 · YaRN — Peng et al. —
  https://arxiv.org/abs/2309.00071

### Construcción de contexto y prompting

- Anthropic, Effective context engineering —
  https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic prompting best practices —
  https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
- OpenAI prompt engineering —
  https://help.openai.com/en/articles/6654000-best-practices-for-prompt-engineering-with-the-openai-api
- OpenAI Structured Outputs — https://developers.openai.com/api/docs/guides/structured-outputs
- Fantastically Ordered Prompts — Lu et al. — https://aclanthology.org/2022.acl-long.556/ · Calibrate Before Use — Zhao
  et al. — https://arxiv.org/abs/2102.09690

### Defensas contra prompt injection

- Spotlighting — Hines et al., Microsoft — https://arxiv.org/abs/2403.14720

### Gestión de ventana, compaction, memoria, caching

- LangChain context engineering — https://www.langchain.com/blog/context-engineering-for-agents ·
  https://rlancemartin.github.io/2025/06/23/context_engineering/
- Anthropic context management — https://claude.com/blog/context-management · compaction —
  https://platform.claude.com/docs/en/build-with-claude/compaction
- LLMLingua / LongLLMLingua — https://arxiv.org/abs/2310.05736 · https://arxiv.org/abs/2310.06839
- MemGPT — Packer et al. — https://arxiv.org/abs/2310.08560 · Recursive summarization — Wu et al. —
  https://arxiv.org/abs/2109.10862
- CoALA — https://arxiv.org/html/2309.02427v3 · Generative Agents — https://arxiv.org/abs/2304.03442 · LangGraph memory
  — https://docs.langchain.com/oss/python/langgraph/add-memory
- Anthropic prompt caching — https://platform.claude.com/docs/en/build-with-claude/prompt-caching

### Retrieval / RAG

- Anthropic Contextual Retrieval — https://www.anthropic.com/engineering/contextual-retrieval · BEIR —
  https://arxiv.org/abs/2104.08663
- HyDE — https://arxiv.org/abs/2212.10496 · Self-RAG — https://arxiv.org/abs/2310.11511 · CRAG —
  https://arxiv.org/abs/2401.15884 · GraphRAG — https://arxiv.org/abs/2404.16130 · Late chunking —
  https://arxiv.org/abs/2409.04701
- LC vs RAG — https://arxiv.org/abs/2501.01880 · Self-Route — https://arxiv.org/abs/2407.16833 · long-context limits —
  https://arxiv.org/abs/2411.03538
- Filesystem vs vector search — LlamaIndex — https://www.llamaindex.ai/blog/did-filesystem-tools-kill-vector-search

### Arquitectura de harness y agentes

- Cognition, Don’t build multi-agents — https://cognition.com/blog/dont-build-multi-agents · update —
  https://cognition.com/blog/multi-agents-working
- Anthropic multi-agent research system — https://www.anthropic.com/engineering/multi-agent-research-system
- LongFuncEval — https://arxiv.org/abs/2505.10570 · RAG-MCP — https://arxiv.org/abs/2505.03275 · ToolRet —
  https://arxiv.org/abs/2503.01763
- Anthropic Tool Search — https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool · Writing tools
  for agents — https://www.anthropic.com/engineering/writing-tools-for-agents
- LangChain Deep Agents — https://docs.langchain.com/oss/python/deepagents/context-engineering

### Steering de atención y KV-cache

- Manus context engineering — https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- Scissorhands — https://arxiv.org/abs/2305.17118 · H2O — https://arxiv.org/abs/2306.14048 · SnapKV —
  https://arxiv.org/abs/2404.14469
- PASTA — https://arxiv.org/abs/2311.02262 · AutoPASTA — https://arxiv.org/abs/2409.10790 · Activation steering —
  https://arxiv.org/abs/2410.12877

### Evaluación y observabilidad

- LongBench v2 — https://arxiv.org/abs/2412.15204 · τ-bench — https://openreview.net/forum?id=roNSXZpUDN · TRAJECT-Bench
  — https://arxiv.org/html/2510.04550v2
- OpenTelemetry GenAI agent spans — https://github.com/open-telemetry/semantic-conventions-genai · HAL harness —
  https://github.com/princeton-pli/hal-harness

---

## 7. Preguntas abiertas y vacíos de cobertura

- **Mecanismo vs. medición.** Sigue sin resolverse si lost-in-the-middle, context rot y attention-sink behavior
  comparten una sola causa (positional encoding vs. attention dilution vs. softmax mass allocation). StreamingLLM
  explica streaming/eviction, no toda la pérdida en el medio.
- **¿Recitation realmente ayuda?** El “re-anchor the goal / rewrite todo.md” de Manus se reporta solo en forma
  cualitativa; no hay una ablation controlada que cuantifique la ganancia.
- **Transferencia costo/beneficio de multi-agent.** El +90.2% de Anthropic es una evaluación de research retrieval; el
  multiplicador de costo respecto del baseline single-agent que produjo esa mejora no se indica, y la transferencia a
  coding write-heavy es desconocida.
- **LC vs RAG no tiene ganador universal.** El routing depende del tipo de consulta, la escala del corpus y la
  generación del modelo — medilo por sistema.
- **Amplitud de evaluación.** Este informe se apoya en RULER / NoLiMa / Context Rot / LongBench v2; la revisión señala
  HELMET, ∞Bench (InfiniteBench), Michelangelo y BABILong como formas de ampliar la suite de aceptación (todavía no
  integradas aquí).
- **Vacío de procedencia.** Una rama de research (attention steering) quedó parcialmente corrupta; §3e cita magnitudes
  de PASTA/AutoPASTA, pero no se re-verificaron de forma independiente.

---

## 8. Confianza y advertencias

**Sólido (spot-checked contra fuentes primarias por el revisor adversarial):** la tabla de mecanismos de §2; Context
Rot, NoLiMa, Anthropic Contextual Retrieval, Anthropic multi-agent +90.2%, y los hallazgos de LlamaIndex
filesystem-vs-RAG; la reconciliación arquitectónica Cognition-vs-Anthropic en §3d.

**Corregido durante la revisión (estaba mal o sobreafirmado en el primer borrador):** la confusión de la base de costo
“15×” en multi-agent (15× es vs _chat_, no vs single-agent); el framing causal de O(n²) en el executive summary
(reformulado como correlación observada); “Always rerank / single largest precision lift” (suavizado a “cuando importa
la precisión y la latencia lo permite”); los IDs de arXiv financieros futuros e irresolubles y sus números (eliminados);
“cited by N branches” (reemplazado por fuentes externas distintas); “18 frontier models” → “18 models”.

**Frágil / `[UNVERIFIED]`** (plausible, bien citado, no re-verificado de forma independiente aquí): el threshold 85.6% /
13 tareas de RULER; PASTA ~22% / AutoPASTA +7.95%; RAG-MCP 43.13% vs 13.62%; LongFuncEval 7%–85%; GSM-IC
95%→72.4%→88.1%; caching vendor “~90% cost / ~85% latency”; la cifra long-doc de Anthropic “+30%”.

**Procedencia de este documento:** producido por un workflow dinámico de 4 etapas (7 ramas de web-research de solo
lectura → síntesis → revisión adversarial → revisión). El artifact final de la revisión automática alcanzó el límite de
salida de subagents y truncó a mitad de §4, así que §1–§3e son la revisión corregida por el revisor, §4–§5 se
restauraron desde el borrador de síntesis, y §6–§8 se armaron con la evidencia reunida y las notas de confianza del
revisor. Run: `2026-06-28T10-04-04-932Z-drafts-context-engineering-focus-6c131aa1`.
