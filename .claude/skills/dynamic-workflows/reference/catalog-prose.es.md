<!-- Fuente canónica del catálogo de workflows (prosa ES, estilo pandi).
     Editá solo este archivo; los destinos se generan con npm run sync:scaffold-catalog. -->

> **Regla de oro: empezá simple.** Una sola llamada a `agent` le gana a un workflow en casi todo. Usá un workflow solo
> cuando necesites una de estas tres cosas: **exhaustividad** (cubrir un repo/corpus entero), **confianza** (verificar
> antes de confiar) o **escala** (más de una ventana de contexto). Como dice Anthropic: _"add complexity only when it
> delivers measurable value."_

```text
one agent  ──good enough?──>  ✅ done
     │ no (need coverage / confidence / scale)
     ▼
 a workflow
```

---

## 1. Inicio rápido

Podés invocar un workflow de dos maneras:

| Forma                   | Cuándo                                                                 | Ejemplo                                                                 |
| ----------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `name`                  | El workflow ya estaba presente al iniciar la sesión                    | `{ name: 'self-consistency', args: {...} }`                             |
| `scriptPath` (absoluto) | Archivo nuevo, archivo en `drafts/` o cualquier cosa en una subcarpeta | `{ scriptPath: '/Users/you/.claude/workflows/router.js', args: {...} }` |

> **La advertencia de 2 líneas.** El descubrimiento por nombre es un **snapshot del inicio de la sesión** y **NO**
> recorre subcarpetas. Un workflow creado en mitad de la sesión, o ubicado bajo `drafts/`, no va a resolver por `name`.
> Solución: llamalo por `scriptPath` absoluto, o hacé un symlink dentro de `~/.claude/workflows/` e iniciá una sesión
> nueva.

**Copy-paste mínimo:**

```js
Workflow({
  name: "complex-research",
  args: {
    question: "¿Cuáles son los tradeoffs entre WASM y NAPI para Node FFI en 2026?",
  },
});
```

---

## 2. Mapa del catálogo

Los 25 workflows agrupados por **familia**. Las flechas muestran **composición** (un workflow llama a otro vía
`workflow()`).

```mermaid
flowchart TB
  subgraph GG["Acotar y proteger"]
    CG[contract-gate]
    GR[guardrails]
  end
  subgraph RO["Rutear y orquestar"]
    RT[router]
    OW[orchestrator-workers]
    MR[map-reduce]
  end
  subgraph DF["Descubrir y abrir fan-out"]
    FO[fan-out-and-synthesize]
    SF[scout-fanout]
    RB[repo-bug-hunt]
    LD[loop-until-dry]
    RS[react-scout]
    CR[complex-research]
  end
  subgraph VE["Verify"]
    AV[adversarial-verify]
    BV[bug-verify]
    VL[verify-claims-lib]
    APR[adversarial-plan-review]
  end
  subgraph GS["Generate & select"]
    JE[judge-escalate]
    TN[tournament]
    SC[self-consistency]
    TOT[tree-of-thoughts]
  end
  subgraph IR["Iterate & refine"]
    SR[self-refine]
    RX[reflexion]
    LM[large-migration]
  end
  subgraph CM["Compose & meta"]
    CD[composition-driver]
    WF[workflow-factory]
    RC[recursive-compose]
  end

  CG -. "generate=true" .-> WF
  RT == "dispatch (cualquier workflow)" ==> DF
  GR -. "protect:{name}" .-> RO
  CD --> VL
  SR -. "useJury" .-> AV
  WF -. "scaffolds new" .-> CM
  OW -- "planner→workers→integrator" --> OW
  RC -. "re-gate (Phase 0)" .-> CG
  RC == "then dispatch" ==> RT
```

**Cómo leerlo.** `contract-gate` puede derivar en `workflow-factory`; `router` despacha a _cualquier_ workflow del
catálogo; `guardrails` envuelve _cualquier_ workflow; `composition-driver` llama a `verify-claims-lib`; `self-refine`
puede usar `adversarial-verify` como crítico; `orchestrator-workers` internamente sigue planner→workers→integrator;
`reflexion`/`react-scout`/`bug-verify` son workflows _grounded_ (anclados en evidencia: ejecutan comandos u
observaciones reales).

---

## 3. Cómo elegir un workflow

Empezá arriba y tomá la primera fila que aplique.

| Si querés…                                                                | Usá                                                       |
| ------------------------------------------------------------------------- | --------------------------------------------------------- |
| **Acotar un pedido vago** antes de hacer nada (preguntar vs seguir)       | `contract-gate`                                           |
| **Que elija por mí** el workflow correcto y lo ejecute                    | `router`                                                  |
| **Cobertura amplia e independiente** de una work-list / repo              | `fan-out-and-synthesize`, `scout-fanout`, `repo-bug-hunt` |
| **Encontrar bugs en un repo** (pistas, no confirmaciones)                 | `repo-bug-hunt`, `scout-fanout`                           |
| **Converger en una respuesta** a partir de muchos caminos de razonamiento | `self-consistency`                                        |
| **Descubrir un conjunto de tamaño desconocido** (seguir hasta secarse)    | `loop-until-dry`                                          |
| **Anclar cada paso en observaciones reales** antes de abrir fan-out       | `react-scout`                                             |
| **Verificar claims / findings** (podar los falsos)                        | `adversarial-verify`, `verify-claims-lib`                 |
| **Confirmar bugs de código ejecutándolos**                                | `bug-verify`                                              |
| **Best of N** candidatos                                                  | `judge-escalate`, `tournament`                            |
| **Iterar hasta llegar a calidad** sobre un artifact                       | `self-refine`, `reflexion`                                |
| **Explorar un espacio de soluciones** con pasos intermedios               | `tree-of-thoughts`                                        |
| **Descomponer un goal abierto** en un grafo de subtareas                  | `orchestrator-workers`                                    |
| **Procesar un corpus enorme** que excede una ventana de contexto          | `map-reduce`                                              |
| **Imponer límites duros** alrededor de una corrida (tripwire)             | `guardrails`                                              |
| **Investigar una pregunta** con citas                                     | `complex-research`                                        |
| **Revisar un plan** antes de construir                                    | `adversarial-plan-review`                                 |
| **Aplicar una migración grande de código** con seguridad                  | `large-migration`                                         |
| **Generar un workflow NUEVO** para una tarea                              | `workflow-factory`                                        |
| **Componer un workflow padre + uno reutilizable**                         | `composition-driver` (+ `verify-claims-lib`)              |

```mermaid
flowchart TD
  A[Pedido crudo] --> B{¿Es ambiguo o de alto riesgo?}
  B -- sí --> CG[contract-gate]
  B -- no --> C{¿Sabés qué workflow usar?}
  C -- no --> RT[router]
  C -- sí --> D{¿Cuál es el trabajo?}
  D -- cubrir un repo/corpus --> E[fan-out / scout-fanout / repo-bug-hunt / map-reduce]
  D -- ganar confianza --> F[adversarial-verify / bug-verify / self-consistency]
  D -- elegir el mejor de N --> G[judge-escalate / tournament / tree-of-thoughts]
  D -- mejorar un artifact --> H[self-refine / reflexion / large-migration]
  D -- descomponer un goal --> I[orchestrator-workers]
  D -- crear un workflow nuevo --> J[workflow-factory]
```

---

## 4. Fase 0 — `contract-gate`

> **Cuándo/por qué.** Corré esto **primero**, antes de rutear o construir, siempre que el pedido sea vago, de alto
> riesgo o pueda significar dos cosas distintas. Convierte “hacé X” en un **contrato** inspeccionable y decide la única
> pregunta humana que importa: **¿preguntar ahora o seguir con una suposición registrada?** Una spec limpia es la
> palanca más grande sobre la calidad aguas abajo.

```mermaid
flowchart TD
  RAW["raw ask"] --> AN["Analyze: N independent reviewers + synthesis"]
  AN --> GATE{"value-of-information gate"}
  GATE -- "BLOCKED (impacto ALTO, sin valor por defecto seguro)" --> Q["status=NEEDS_CLARIFICATION\ndevolver preguntas · STOP"]
  GATE -- "PROCEED (assume + record)" --> RW["Rewrite → rewrittenPrompt (improvePrompt)"]
  RW --> RP["resourcePlan (per-node model·effort, if dynamic-workflow)"]
  RP --> HO{"generate=true AND routing=dynamic-workflow?"}
  HO -- yes --> WF["workflow-factory(task, name, write)"]
  HO -- no --> OUT["return contract + rewrittenPrompt"]
```

**Parámetros** (`request` requerido; aliases `task`/`text`/`question`):

| Parámetro       | Por defecto              | Significado                                                                                                           |
| --------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `reviewers`     | `3` (clamp 1..5)         | Revisores independientes del contrato + síntesis; 1 = un único análisis barato                                        |
| `improvePrompt` | `true`                   | Reescribe el contrato como un `rewrittenPrompt` limpio y autocontenido; `false` reenvía el pedido crudo + el contrato |
| `generate`      | `false`                  | En PROCEED **y** con `routing=dynamic-workflow`, deriva a `workflow-factory`                                          |
| `planResources` | `true`                   | Emite `resourcePlan` (sugerencia de model·effort por nodo para el workflow recomendado, escalada según el riesgo)     |
| `maxQuestions`  | `4` → clamped a **1..3** | Tope de preguntas bloqueantes                                                                                         |
| `context`       | `""`                     | Contexto extra opcional que se adjunta al análisis + rewrite                                                          |
| `name`, `write` | — / `true`               | Se pasan a `workflow-factory` en el handoff                                                                           |

**Devuelve:** `{ status, verdict, contract, rewrittenPrompt, questions?, routing, resourcePlan?, generated? }`, donde
`verdict ∈ {PROCEED, BLOCKED}` y `status` lo refleja (`PROCEED` / `NEEDS_CLARIFICATION`).

**Ejemplo A — pedido claro → PROCEED:**

```js
Workflow({
  name: "contract-gate",
  args: {
    request: "Audit packages/coding-agent/src/core for null-deref bugs and produce a cited, prioritized list.",
  },
});
// → { status:'PROCEED', verdict:'PROCEED', contract:{...},
//     rewrittenPrompt:'<clean self-contained spec>', routing:{ shape:'dynamic-workflow', pattern:'repo-bug-hunt', ... },
//     resourcePlan:{ tier:'balanced', pattern:'repo-bug-hunt', models:{...}, efforts:{...} } }
```

**Ejemplo B — pedido ambiguo → NEEDS_CLARIFICATION:**

```js
Workflow({ name: "contract-gate", args: { request: "Make the streaming faster." } });
// → { status:'NEEDS_CLARIFICATION', verdict:'BLOCKED',
//     questions:[ { question:'Which provider path (Anthropic / OpenAI / Ollama)?', rationale:'...' },
//                 { question:'Faster by what metric — TTFB, throughput, or total latency?', rationale:'...' },
//                 { question:'What is the acceptance bar / target?', rationale:'...' } ] }   // STOP — no rewrite, no handoff
```

**Cómo pasar `rewrittenPrompt` aguas abajo** — es el artifact durable del handoff:

```js
const gate = Workflow({ name: "contract-gate", args: { request: rawAsk } });
if (gate.status === "PROCEED") {
  Workflow({ name: "router", args: { request: gate.rewrittenPrompt } }); // dejar que router elija + corra
  // or: Workflow({ name: 'workflow-factory', args: { task: gate.rewrittenPrompt } });    // generar un workflow nuevo
  // o pasar rewrittenPrompt a cualquier workflow específico que ya hayas elegido
}
```

---

## 5. Cómo componer

Hay exactamente **cuatro costuras de composición**. Todo lo demás es solo una llamada a `agent()`.

```mermaid
flowchart LR
  subgraph S1["a) llamada a sub-workflow"]
    P[padre] -->|"workflow(name,args)"| C[verify-claims-lib]
  end
  subgraph S2["b) wrapper / envoltorio"]
    G["guardrails (protect:{name,args})"] --> W[cualquier workflow]
  end
  subgraph S3["c) dispatch / despacho"]
    R[router] -->|"elige + corre"| X[cualquier workflow]
  end
  subgraph S4["d) generación"]
    F[workflow-factory] -->|"escribe"| N["drafts/new.js"]
  end
```

| Costura             | Cómo                                                         | Ejemplo canónico                                 |
| ------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| **a) sub-workflow** | `workflow(name, args)` dentro de un padre                    | `composition-driver` → `verify-claims-lib`       |
| **b) wrapper**      | `guardrails` con `protect:{ name, args }`                    | tripwire IN/OUT alrededor de cualquier corrida   |
| **c) dispatch**     | `router` lee el catálogo, elige uno y lo ejecuta             | dale una tarea cruda                             |
| **d) generation**   | `workflow-factory` planifica→genera→escribe un archivo nuevo | scaffold de un workflow específico para la tarea |

**Ejemplo completo** (acotar → rutear → proteger la corrida elegida):

```js
// 1) ACOTAR el pedido.
const gate = Workflow({ name: "contract-gate", args: { request: rawAsk } });
if (gate.status !== "PROCEED") return gate.questions; // preguntarle al humano y frenar

// 2) RUTEAR: solo recomendación, para poder envolver la elección en vez de correrla en crudo.
const pick = Workflow({
  name: "router",
  args: {
    request: gate.rewrittenPrompt,
    runSelected: false, // → { selected, suggestedArgs, ... }
  },
});

// 3) PROTEGER: ejecutar el workflow elegido detrás de tripwires de input/output.
Workflow({
  name: "guardrails",
  args: {
    inputRules: ["must stay within packages/coding-agent", "read-only — no file writes"],
    outputRules: ["every finding cites a file:line"],
    protect: { name: pick.selected, args: pick.suggestedArgs },
  },
});
```

### Composición y nested runs (dos límites distintos)

La composición con `workflow()` tiene **depth 1** tanto en pi como en la Workflow tool de Claude Code: solo el workflow
top-level puede componer hijos. Un hijo compuesto no puede volver a llamar `workflow()`.

| Mecanismo | Límite | Cómo continuar |
| --------- | ------ | -------------- |
| Composición `workflow()` | depth 1 en pi y Claude Code | Aplaná los hijos como hermanos del top-level o devolvé una recomendación. |
| Nested top-level runs de pi | default 2, configurable con `PI_DYNAMIC_WORKFLOWS_MAX_DEPTH` | El orquestador abre otra corrida después de recibir la recomendación. |

`PI_DYNAMIC_WORKFLOWS_MAX_DEPTH` protege nuevas corridas top-level iniciadas desde sesiones de subagentes; no amplía
la composición dentro de una corrida.

> **Referencia trabajada — `recursive-compose.js`.** Llama a `contract-gate` y `router` como dos hijos hermanos de
> depth 1. Router corre con `runSelected:false`; si elige un scaffold, la referencia devuelve `DEPTH_BLOCKED`, la
> recomendación y `dispatchArgs`. El orquestador puede usar esos datos para abrir otra corrida top-level. El
> `dispatchArgs` combina las tres fuentes con precedencia `resourcePlan` > overrides de entrada >
> `recommendation.suggestedArgs`.

---

## 6. Los 25 workflows por familia

Cada entrada incluye: **propósito** · **usar cuando** · **parámetros clave (valores por defecto)** · **ejemplo** ·
**casos de uso**.

### Acotar y proteger

**`contract-gate`** — gate de contrato de Fase 0 (detalle completo en §4).

- _Usar cuando:_ el pedido es vago o de alto riesgo y querés decidir primero preguntar-vs-seguir.
- _Parámetros:_ `request` (req) · `reviewers=3` · `improvePrompt=true` · `generate=false` · `maxQuestions=4→1..3`.
- _Casos de uso:_ acotar un ticket borroso; poner un gate antes de una corrida multiagente costosa.

**`guardrails`** — tripwire barato de input/output que **se detiene** ante una violación clara.

- _Usar cuando:_ necesitás imponer límites duros con bajo costo alrededor de una corrida, o validar un artifact.
- _Parámetros:_ `inputRules[]` / `outputRules[]` (o `rules[]`) · `content` (modo validator) · `protect:{name,args}`
  (modo wrapper) · `strict=false` (fail-closed: si el guard crashea, cuenta como disparado).
- _Ejemplo:_
  ```js
  Workflow({ name: "guardrails", args: { outputRules: ["no secrets in output"], content: draft } });
  ```
- _Casos de uso:_ gate de alcance/seguridad antes de correr un agente; chequeo de PII/secrets sobre una salida.

### Rutear y orquestar

**`router`** — clasifica un pedido y hace **dispatch** al mejor workflow único del catálogo.

- _Usar cuando:_ no querés nombrar vos el workflow.
- _Parámetros:_ `request` (req; aliases `task`/`text`) · `candidates?[]` · `runSelected=true` · `args?` · `context?` ·
  `maxCandidates=60` (clamp 1..200).
- _Ejemplo:_
  ```js
  Workflow({
    name: "router",
    args: { request: "Auditá ./src/auth en busca de IDOR y controles faltantes; entregá un informe con citas." },
  });
  // → { selected:'repo-bug-hunt', why, dispatched:true, output:<that workflow's result>, candidates:[...] }
  ```
- _Casos de uso:_ una única puerta de entrada para tareas crudas; modo recomendación (`runSelected:false`) para
  previsualizar la elección.

**`orchestrator-workers`** — un **planner** descompone un goal abierto en un grafo de subtareas `dependsOn`, los
**workers** lo ejecutan nivel por nivel (topológico, con fallas parciales visibles) y un **integrator** fusiona
resultados.

- _Usar cuando:_ el goal es abierto y sus subtareas o su forma no se conocen de antemano.
- _Parámetros:_ `goal` (req; aliases `task`/`text`) · `context?` · `maxSubtasks=8` (clamp 1..30) · `concurrency?`.
- _Ejemplo:_
  ```js
  Workflow({
    name: "orchestrator-workers",
    args: {
      goal: "Prepará un brief de launch readiness: evaluá la paridad de SSE, enumerá triggers de rollback, redactá la secuencia de rollout y escribí el resumen ejecutivo.",
      maxSubtasks: 6,
      concurrency: 3,
      efforts: { planner: "xhigh", integrator: "high" },
    },
  });
  // → { result, plan:{ subtasks:[{id,description,dependsOn}], schedule, ... }, workers:[{id,status,output}] }
  ```
- _Casos de uso:_ entregables multiparte; goals de investigación/construcción con interdependencias.

**`map-reduce`** — map-reduce jerárquico (recursivo): **map** por chunk bajo un contrato de evidencia → **reduce** en
lotes acotados hasta que queda un único summary-of-summaries.

- _Usar cuando:_ el input es más grande que una ventana de contexto.
- _Parámetros:_ `instruction` (req) · `items?[]` **o** `content?` (uno requerido; `items` gana) · `chunkChars=8000`
  (500..200000) · `reduceBatch=5` (2..20) · `maxChunks=400` (1..2000) · `maxRounds` adaptativo.
- _Ejemplo:_
  ```js
  Workflow({
    name: "map-reduce",
    args: {
      instruction: "Extract every breaking API change with affected symbol + one-line migration note; cite the span.",
      content: veryLongChangelog,
      chunkChars: 6000,
      reduceBatch: 4,
    },
  });
  // → { result, chunks, mapCount, reduceRounds }
  ```
- _Casos de uso:_ resumir un doc/log enorme; consolidar cientos de tickets.

### Descubrir y abrir fan-out

**`fan-out-and-synthesize`** — patrón base scatter-gather: scout de una work-list → un reviewer por ítem (paralelo,
settle) → síntesis-como-juez con notas de cobertura/fallas.

- _Usar cuando:_ necesitás cobertura amplia e independiente de una work-list más o menos conocida.
- _Parámetros:_ `limit=12` · `pattern='code'` (preset `code|docs|web|config` o regex cruda) · `lens='code'` (preset
  `code|security|prose` o texto libre) · `files?[]`.
- _Ejemplo:_ `Workflow({ name:'fan-out-and-synthesize', args:{ lens:'security', limit:20 } });`
- _Casos de uso:_ repartir review entre muchos archivos; síntesis multiángulo.

**`scout-fanout`** — scout → pipeline de **profundidad adaptativa**: clasifica barato el riesgo de _cada_ archivo y hace
deep-review solo sobre los de riesgo alto/medio; los de riesgo bajo cortan temprano.

- _Usar cuando:_ querés cobertura, pero solo querés pagar por los ítems riesgosos.
- _Parámetros:_ `pattern='code'` · `lens='code'` · `maxFiles=40` (clamp 1..200) · `files?[]`.
- _Ejemplo:_ `Workflow({ name:'scout-fanout', args:{ pattern:'config', lens:'security' } });`
- _Casos de uso:_ triage-y-review sobre un árbol grande; pasadas de clasificar-y-actuar.

**`repo-bug-hunt`** — scout de archivos de código → reviewers de bugs por archivo → juez que deduplica y prioriza con
citas. **Los findings son pistas, no bugs confirmados.**

- _Usar cuando:_ querés una lista priorizada y citada de bugs sospechados en un repo.
- _Parámetros:_ `files?[]` · `maxFiles=40` · `concurrency=6` · `pattern='code'` · `lens='code'`.
- _Ejemplo:_ `Workflow({ name:'repo-bug-hunt', args:{ maxFiles:30, lens:'security' } });`
- _Casos de uso:_ auditoría de repo; pasada previa a review (después confirmar con `bug-verify`).

**`loop-until-dry`** — sigue abriendo fan-out de finders hasta **K rondas consecutivas en silencio** o `maxRounds`.

- _Usar cuando:_ el conjunto que estás descubriendo tiene tamaño desconocido y querés exhaustividad.
- _Parámetros:_ `target`/`scope`/`task` (req) · `quietRounds=2` · `maxRounds=8` · `finders=3` (clamp 1..6).
- _Ejemplo:_ `Workflow({ name:'loop-until-dry', args:{ target:'all places we parse SSE chunks', quietRounds:2 } });`
- _Casos de uso:_ enumerar todos los call-sites/casos borde; “encontrá todo lo que…”.

**`react-scout`** — loop ReAct reason→act→observe: cada paso ancla un pensamiento en una **observación real de solo
lectura** antes del siguiente.

- _Usar cuando:_ necesitás un scout basado en evidencia antes de comprometerte o abrir fan-out.
- _Parámetros:_ `question` (req; aliases `q`/`text`/`topic`) · `maxSteps=6` (clamp 1..50) ·
  `tools=['read','grep','find','ls','web_search']`.
- _Ejemplo:_ `Workflow({ name:'react-scout', args:{ question:'Where does the WASM decoder get fed bytes?' } });`
- _Casos de uso:_ investigación anclada en evidencia; producir `result.trace` para dárselo a un fan-out.

**`complex-research`** — ángulos de investigación independientes (cada uno corre web search) → síntesis-como-juez con
citas y huecos de cobertura.

- _Usar cuando:_ necesitás una respuesta citada a una pregunta externa.
- _Parámetros:_ `question` (req; aliases `q`/`text`) · `angles?[]` (por defecto 4: fuentes primarias / opciones y
  tradeoffs / riesgos y migración / mejor recomendación).
- _Ejemplo:_ `Workflow({ name:'complex-research', args:{ question:'WASM vs NAPI FFI for Node in 2026?' } });`
- _Casos de uso:_ comparaciones tecnológicas; barridos de literatura/panorama. _Conviene emparejarlo con un paso de
  verify si la respuesta tiene consecuencias._

### Verify

**`adversarial-verify`** — **jury escéptico** por finding que poda por refutación mayoritaria; duda por defecto.

- _Usar cuando:_ ya tenés findings/claims y querés quedarte solo con los que sobreviven la refutación.
- _Parámetros:_ `findings?[]` (si no, se descubren desde `topic`) · `skeptics=3` (clamp 1..99) · `maxFindings=8`.
- _Ejemplo:_
  `Workflow({ name:'adversarial-verify', args:{ topic:'security claims about our token flow', skeptics:5 } });`
- _Casos de uso:_ podar una lista ruidosa de findings; sanity-check de claims antes de actuar.

**`bug-verify`** — confirma bugs sospechados por **REPRODUCTION**: un bug es real solo si una corrida falla de verdad
sobre el código actual; opcionalmente chequea FAIL→PASS tras un fix y hace minimización.

- _Usar cuando:_ necesitás _probar_ un bug, no solo argumentarlo. Corre **en secuencia** sobre el working tree.
- _Parámetros:_ `bugs?[]` **o** `topic` · `verifyCmd` (por ejemplo, `"npm test"`) · `attemptFix=false` ·
  `minimize=false` · `maxBugs=12`.
- _Ejemplo:_
  `Workflow({ name:'bug-verify', args:{ topic:'SSE decoder drops final chunk', verifyCmd:'npm test', attemptFix:true } });`
- _Casos de uso:_ confirmar pistas de `repo-bug-hunt`; loop de reproducir-y-arreglar.

**`verify-claims-lib`** — **sub-workflow** reutilizable: verifica `{claims, skeptics?}` con juries escépticos.

- _Usar cuando:_ un workflow padre necesita verificación como bloque de construcción.
- _Parámetros:_ `claims[]` (req) · `skeptics=3` (clamp 1..64) · `topic?`.
- _Devuelve:_ `{ verified, dropped, votes, coverage }`.
- _Casos de uso:_ lo llama `composition-driver`; útil para cualquier padre que primero descubre y después verifica.

**`adversarial-plan-review`** — N reviewers de ángulos fijos (correctness, security, maintainability, scope) →
sintetizan un plan revisado.

- _Usar cuando:_ querés stress-testear un plan antes de construir.
- _Parámetros:_ `plan`/`text` (req). El fan-out queda topeado en 4 reviewers; si todos fallan → `INSUFFICIENT_EVIDENCE`.
- _Ejemplo:_ `Workflow({ name:'adversarial-plan-review', args:{ plan: theImplementationPlan } });`
- _Casos de uso:_ review de diseño/RFC; gate previo a implementación.

### Generate & select

**`judge-escalate`** — genera candidatos desde ángulos distintos → juez tipado → **escala solo cuando la confianza es
baja**.

- _Usar cuando:_ querés best-of-N y preferís profundizar antes que comprometerte con un ganador débil.
- _Parámetros:_ `question` (req; aliases `q`/`text`) · `angles=['risk-first','simplicity-first','user-first']` (máx. 8)
  · `maxEscalations=2`.
- _Ejemplo:_ `Workflow({ name:'judge-escalate', args:{ question:'Best rollback strategy for the gate?' } });`
- _Casos de uso:_ decisiones con ganador claro la mayoría de las veces; gasto adaptativo.

**`tournament`** — bracket de eliminación simple: rondas de juez por pares hasta que sobrevive uno (`ceil(log2 n)`
rondas; si el campo es impar, alguien pasa con bye).

- _Usar cuando:_ el scoring absoluto no es confiable, pero la comparación de a pares sí.
- _Parámetros:_ `candidates?[]` (si no, se generan desde `angles`) · `topic?` ·
  `angles=['risk-first','simplicity-first','user-first','cost-first']`.
- _Ejemplo:_ `Workflow({ name:'tournament', args:{ candidates:[a,b,c,d] } });`
- _Casos de uso:_ elegir el mejor entre varios drafts/diseños mediante enfrentamientos head-to-head.

**`self-consistency`** — muestrea N caminos de razonamiento independientes → elige la respuesta por **consensus**
(voto), y desempata con un juez que pondera evidencia.

- _Usar cuando:_ una sola cadena podría estar mal y la señal que más confiás es el acuerdo.
- _Parámetros:_ `question` (req; aliases `q`/`text`) · `samples=5` (clamp 2..20). Los samplers corren con `cache:false`
  para que la independencia sea real.
- _Ejemplo:_
  `Workflow({ name:'self-consistency', args:{ question:'Does this code path leak the handle?', samples:7 } });`
- _Casos de uso:_ razonamiento/matemática/juicio de alta varianza; conviene reportar el margen de consenso.

**`tree-of-thoughts`** — beam-search sobre soluciones parciales: expandir K thoughts → juez puntúa → poda al top-B →
recursa hasta la profundidad → commit.

- _Usar cuando:_ el problema tiene **pasos intermedios** que vale la pena explorar, no solo candidatos finales.
- _Parámetros:_ `problem` (req; aliases `question`/`text`/`task`) · `branching=3` (clamp 2..8) · `beam=2` (clamp 1..16)
  · `depth=3`.
- _Ejemplo:_ `Workflow({ name:'tree-of-thoughts', args:{ problem:'Design the gate rollout in 4 staged steps.' } });`
- _Casos de uso:_ búsqueda de diseño/planificación multi-step; `judge-escalate` equivale a esto con depth=1 y beam=1.

### Iterate & refine

**`self-refine`** — loop acotado generate→critique→refine in-place con memoria verbal; corta en silencio cuando el
crítico queda satisfecho.

- _Usar cuando:_ querés pulir **un** artifact y la crítica puede ser intrínseca.
- _Parámetros:_ `task` (req; aliases `question`/`text`) · `maxRounds=4` · `useJury=false` (reemplaza el crítico por el
  jury de `adversarial-verify`, una señal independiente más fuerte) · `skeptics=3` (tamaño del jury cuando `useJury`).
- _Ejemplo:_ `Workflow({ name:'self-refine', args:{ task:'Write the migration guide section.', useJury:true } });`
- _Casos de uso:_ pulido de docs/specs/código donde el retorno cae rápido.

**`reflexion`** — loop externo de verbal-RL **por intento**: vuelve a intentar la tarea completa en cada trial y
arrastra un buffer acotado de self-reflections; el evaluator puede estar **anclado externamente** (ejecuta `verifyCmd`).

- _Usar cuando:_ conviene más volver a intentar desde cero que editar in-place, y además tenés un oráculo objetivo.
- _Parámetros:_ `task` (req; aliases `question`/`text`) · `verifyCmd?` (ancla el evaluator) · `maxTrials=3` ·
  `memoryCap=3` · `actorModel?` / `evaluatorModel?`.
- _Ejemplo:_
  `Workflow({ name:'reflexion', args:{ task:'Make the failing decoder test pass.', verifyCmd:'npm test -- decoder' } });`
- _Casos de uso:_ código-con-tests; tareas con señal pass/fail. (Distinto de `self-refine`: reset y reintento vs edición
  in-place.)

**`large-migration`** — un **applier** real: gate de baseline verde → por archivo hace apply→verify→repair acotado →
**rollback on failure**. Recorre el working tree en secuencia.

- _Usar cuando:_ vas a mutar muchos archivos y no podés dejar ninguno roto.
- _Parámetros:_ `instruction` (req; aliases `task`/`text`) · `files?[]` **o** `pattern` (por defecto: extensiones de
  código) · `verifyCmd` · `maxRepairs=2` · `maxFiles=50` · `triage=true` · `dryRun=false`.
- _Ejemplo:_

  ```javascript
  Workflow({
    name: "large-migration",
    args: { instruction: "Replace X(...) with Y(...)", verifyCmd: "npm run build && npm test", dryRun: true },
  });
  ```

- _Casos de uso:_ rollouts de API/codemod; upgrades de framework.

### Compose & meta

**`composition-driver`** — workflow padre: descubre claims → delega la verificación a `verify-claims-lib` → sintetiza.

- _Usar cuando:_ querés un ejemplo trabajado de workflow padre + sub-workflow reutilizable, o exactamente ese flujo
  descubrir→verificar.
- _Parámetros:_ `topic` (req; aliases `question`/`text`) · `maxClaims=8` (clamp 1..20) · `skeptics=3`.
- _Ejemplo:_ `Workflow({ name:'composition-driver', args:{ topic:'claims in our SSE parity doc' } });`
- _Casos de uso:_ fact-check de un documento; referencia canónica de composición.

**`workflow-factory`** — meta: catálogo → plan → generate → review → refine → **write**
`.claude/workflows/drafts/<slug>.js`.

- _Usar cuando:_ ningún workflow existente encaja y querés scaffoldear uno específico para la tarea.
- _Parámetros:_ `task` (req; aliases `request`/`text`) · `name?` (slug) · `write=true` (`false` devuelve solo el JS).
- _Ejemplo:_

  ```javascript
  Workflow({
    name: "workflow-factory",
    args: { task: "Audit GraphQL resolvers for N+1 queries and emit a cited report." },
  });
  ```

- _Casos de uso:_ bootstrap de un patrón nuevo; especializar el scaffold existente más cercano. **La salida es un draft:
  inspeccionala antes de confiarle trabajo costoso o mutante.**

**`recursive-compose`** — BOUNDARY REFERENCE: re-acota una tarea vía `contract-gate`, consulta `router` sin dispatch y
explicita el límite de composición depth 1.

- _Usar cuando:_ querés inspeccionar la frontera gate→router→selected o diseñar una continuación top-level segura.
- _Parámetros:_ `task` (req; aliases `request`/`text`) · `context?` · `args?` (se devuelven como base de `dispatchArgs`).
- _Ejemplo:_ `Workflow({ name:'recursive-compose', args:{ task:'audit + fix the SSE decoder' } });` _(devuelve la
  recomendación; no ejecuta el workflow elegido)_
- _Casos de uso:_ probar la frontera depth-1; aplanar composiciones; preparar una corrida top-level separada con el
  `resourcePlan` del gate.

---

## 7. Model, effort, tools y skills por nodo

> **Cuándo/por qué.** Cada workflow enruta cada llamada a `agent` (“nodo”) a través de un helper `node(role, extra)`,
> así que podés definir **model**, **reasoning effort**, **tools** y **skills** por nodo desde el input, sin tocar el
> código. Gastá presupuesto donde paga (judges/verifiers/synthesis), mantené baratos los scouts y dale a cada nodo solo
> las tools/skills que necesita.

- `model` / `effort`: **valores por defecto globales** aplicados a todos los nodos (por ejemplo `{ "effort": "low" }`).
- `models` / `efforts`: **overrides por rol** indexados por el nombre del rol (por ejemplo
  `{ "models": { "synthesis": "opus" } }`).
- `tools` / `skills`: allowlists **globales**, y `excludeTools` una denylist **global** (arrays) aplicadas a todos los
  nodos.
- `toolsByRole` / `skillsByRole` / `excludeByRole`: **overrides por rol** (mapas `role → array`).
- **Precedencia (todos los knobs):** override por rol > valor por defecto global > valor por defecto del call-site
  horneado en el archivo.
- `effort ∈ low | medium | high | xhigh | max`; `model ∈ haiku | sonnet | opus | fable` o un id completo de modelo.

```json
{
  "models": { "scout": "haiku", "synthesis": "opus" },
  "efforts": { "scout": "low", "synthesis": "high" },
  "tools": ["read", "grep", "find", "ls"],
  "toolsByRole": { "migrate": ["read", "edit", "bash"] },
  "skillsByRole": { "synthesis": ["/path/to/skill"] }
}
```

El helper es byte-idéntico en todos los archivos:

```js
const node = (role, extra = {}) => {
  const o = { label: role, ...extra };
  const m = models[role] ?? input?.model;
  if (m != null) o.model = m;
  const e = efforts[role] ?? input?.effort;
  if (e != null) o.effort = e;
  const t = toolsByRole[role] ?? input?.tools;
  if (Array.isArray(t)) o.tools = t;
  const s = skillsByRole[role] ?? input?.skills;
  if (Array.isArray(s)) o.skills = s;
  const x = excludeByRole[role] ?? input?.excludeTools;
  if (Array.isArray(x)) o.excludeTools = x;
  return o;
};
```

> **Nota de runtime para `tools`/`skills`/`excludeTools`.** El scoping de tools/skills por agente **se hace cumplir en
> el runtime de pi** (donde es una opción documentada del agente); ahí sí aísla cada nodo de verdad. En el **runtime
> Workflow de Claude Code es advisory / no enforced** (verificado: un subagente scopeado igual conservó acceso completo
> a archivos), aunque `model`/`effort` **sí** se respetan. Así que tratá tools/skills como intención + enforcement en
> pi, no como frontera de seguridad en Claude Code.

### Claves de rol por workflow — `role → valor sugerido (model · effort)`

| Workflow                  | Roles → valor sugerido                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adversarial-plan-review` | `reviewer` (sonnet·medium), `plan-synthesis` (opus·high)                                                                                                                                    |
| `adversarial-verify`      | `finder` (haiku·low), `skeptic` (opus·high)                                                                                                                                                 |
| `bug-verify`              | `finder` (haiku·low), `tree-baseline` (haiku·low), `repro` (sonnet·medium), `tree-check` (haiku·low)                                                                                        |
| `complex-research`        | `research` (haiku·low), `research-synthesis` (opus·high)                                                                                                                                    |
| `composition-driver`      | `claim-finder` (haiku·low), `composition-synthesis` (opus·high)                                                                                                                             |
| `contract-gate`           | `analyze` (sonnet·medium), `analyze-contract` (sonnet·medium), `analyze-synthesis` (opus·high), `rewrite-prompt` (sonnet·medium), `resource-plan` (sonnet·medium)                           |
| `fan-out-and-synthesize`  | `scout` (haiku·low), `review` (sonnet·medium), `synthesis` (opus·high)                                                                                                                      |
| `guardrails`              | `input-guard` (haiku·low), `output-guard` (haiku·low)                                                                                                                                       |
| `judge-escalate`          | `cand` (sonnet·medium), `judge` (opus·high), `synthesis` (opus·high)                                                                                                                        |
| `large-migration`         | `scout` (haiku·low), `baseline` (haiku·low), `recheck` (haiku·low), `migrate` (sonnet·medium), `final-verify` (haiku·low)                                                                   |
| `loop-until-dry`          | `finder` (haiku·low), `synthesis` (opus·high)                                                                                                                                               |
| `map-reduce`              | `mapper` (haiku·low), `reducer` (sonnet·medium)                                                                                                                                             |
| `orchestrator-workers`    | `planner` (opus·high), `worker` (sonnet·medium), `integrator` (opus·high)                                                                                                                   |
| `react-scout`             | `reason` (sonnet·medium), `observe` (haiku·low), `answer` (opus·high)                                                                                                                       |
| `recursive-compose`       | _(sin claves de rol propias: referencia de frontera; delega a `contract-gate`/`router`, cuyas filas aplican)_                                                                               |
| `reflexion`               | `actor` (sonnet·medium), `evaluator` (opus·high), `reflection` (opus·high) — además `actorModel`/`evaluatorModel`                                                                           |
| `repo-bug-hunt`           | `scout` (haiku·low), `bug-hunt` (sonnet·medium), `synthesis` (opus·high)                                                                                                                    |
| `router`                  | `catalog-scan` (haiku·low), `route` (opus·high)                                                                                                                                             |
| `scout-fanout`            | `scout` (haiku·low), `classify` (haiku·low), `deep` (sonnet·medium), `synthesis` (opus·high)                                                                                                |
| `self-consistency`        | `sample` (haiku·low), `tiebreak` (opus·high)                                                                                                                                                |
| `self-refine`             | `draft` (sonnet·medium), `critique` (opus·high), `refine` (sonnet·medium)                                                                                                                   |
| `tournament`              | `seed` (sonnet·medium), `match` (opus·high)                                                                                                                                                 |
| `tree-of-thoughts`        | `expand` (sonnet·medium), `score` (opus·high), `commit` (opus·high)                                                                                                                         |
| `verify-claims-lib`       | `skeptic` (opus·high)                                                                                                                                                                       |
| `workflow-factory`        | `catalog-scan` (haiku·low), `workflow-plan` (opus·high), `workflow-codegen` (sonnet·medium), `workflow-review` (sonnet·medium), `workflow-refine` (sonnet·medium), `write-file` (haiku·low) |

> `contract-gate` también puede **sugerir** esta tabla completa para el workflow recomendado vía `resourcePlan`
> (`{ tier, models, efforts }`): podés splattearla en la corrida aguas abajo o sobreescribirla.

### Modelos y effort cross-provider (Codex / OpenAI)

Los valores de arriba corresponden al **runtime Workflow de Claude Code**, donde `model` es solo Claude
(`haiku | sonnet | opus | fable`). El **runtime de pi** resuelve `provider/id[:thinking]`, así que esos mismos knobs
también pueden apuntar a **OpenAI Codex**:

```json
{
  "models": { "synthesis": "openai-codex/gpt-5.6-sol", "judge": "openai-codex/gpt-5.6-sol" },
  "efforts": { "synthesis": "xhigh", "judge": "high" }
}
```

| Modelo Codex (mediados de 2026) | Notas                                                               |
| ------------------------------- | ------------------------------------------------------------------- |
| `gpt-5.6-sol`                   | modelo de frontera para síntesis, juicio y coding agéntico complejo |
| `gpt-5.6-terra`                 | tier equilibrado para workers de razonamiento normal                |
| `gpt-5.6-luna`                  | tier económico para scouting, extracción y alto volumen             |
| `gpt-5.3-codex-spark`           | opción especializada disponible en el selector de Codex             |

**Esfuerzo de razonamiento** (Codex `low · medium · high · xhigh`) se alinea 1:1 con nuestro `effort`. _medium_ es el
caballo de batalla diario; _xhigh_ piensa más tiempo.

> **Advertencia de runtime:** los nombres de modelo de Claude (`haiku`/`sonnet`/`opus`/`fable`) aplican bajo el runtime
> de Claude Code; los nombres `provider/id` como los ids de Codex aplican solo cuando corre bajo **pi**.

---

## 8. Convenciones de runtime y authoring

> **Cuándo/por qué.** Leé esto antes de editar o escribir un workflow: el runtime inyecta helpers y hace cumplir unas
> pocas reglas duras.

**Checklist de convenciones:**

- ✅ Solo helper-globals: `agent`, `parallel`, `pipeline`, `workflow`, `phase`, `log`, `args`. **No** `import` /
  `require` / `ctx.*` / globals de Node.
- ✅ `agent(promptString, opts)`: **primero string**, después opciones
  (`{ label, phase, effort, schema, cache, model, tools, skills, excludeTools }`). Nunca `agent({ prompt })`.
- ✅ Con `{ schema }` devuelve el **objeto parseado**; sin eso devuelve el **string de texto**.
- ✅ `args` llega **JSON-stringified**: parsealo de forma defensiva con
  `typeof args === "string" ? JSON.parse(args) : (args || {})`.
- ✅ El tipo de nivel superior de `agent({ schema })` **DEBE ser `object`**: envolvé los arrays dentro de un objeto.
- ✅ Enrutá cada llamada a `agent` a través de `node(role, extra)`; mantené estables los nombres de rol (son las keys de
  `models`/`efforts`).
- ✅ `parallel([thunks])` es una barrera; usá semántica de **settle** para que una rama que crashea resuelva a `null` en
  vez de hundir toda la ronda.
- ✅ Todo loop es **acotado por los dos lados** (tope duro + condición de parada por silencio/satisfacción). **No**
  pongas topes silenciosos: hacé `log()` cada vez que hagas clamp o drop.
- ✅ `meta.name` debe ser igual al nombre del archivo; mantené `meta` como un literal puro.
- ✅ **Basalo en el scaffold existente más cercano y declaralo en la procedencia**: `meta.basedOn` es un array literal
  de `{ name, role }`, uno por cada scaffold reutilizado/especializado/compuesto (por ejemplo
  `meta.basedOn = [{ name: 'fan-out-and-synthesize', role: 'scatter-gather base' }]`). Esto llena la pestaña
  **Based-on** del artifact (lee `meta.basedOn` como string o como array `[{name, role?, desc?}]`; si no, busca un
  comentario inicial `Paper:/Based on:/Source:`); usá `[]` solo si de verdad se construyó desde cero.

**Cómo crear uno nuevo.** **Basalo en el scaffold existente más cercano; no reinventes, y registralo en
`meta.basedOn`.** No lo hagas a mano: corré **`workflow-factory`** con un `task`. Lee el catálogo, prioriza
reutilizar/especializar el scaffold más cercano, compone subpasos reutilizables vía `workflow()` y escribe un draft en
`.claude/workflows/drafts/<slug>.js`. Inspeccioná/editá el draft y después creá un symlink o renombralo dentro de
`~/.claude/workflows/`; por último, iniciá una sesión nueva para que resuelva por `name`.

```mermaid
flowchart LR
  T[task] --> WF[workflow-factory]
  WF --> D["drafts/&lt;slug&gt;.js"]
  D --> I[inspect / edit]
  I --> P[promote to ~/.claude/workflows]
  P --> S[new session → resolves by name]
```
