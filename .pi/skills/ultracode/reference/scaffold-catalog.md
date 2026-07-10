# `~/.claude/workflows` — el catálogo de workflows

**Qué es esto.** Cada archivo `*.js` de acá es un **script de orquestación** que ejecuta la **Workflow tool**. Un script es JavaScript plano que llama a algunos **helper-globals** inyectados (`agent`, `parallel`, `pipeline`, `workflow`, `phase`, `log`, más `args`) para abrir subagentes, iterar, verificar y componer; no hay `import`, `require` ni `ctx.*`. Le pasás un objeto JSON `args`; el script devuelve un valor. Este catálogo tiene **25** workflows.

> **Regla de oro: empezá simple.** Una llamada a un solo agente le gana a un workflow en casi todos los casos. Usá un workflow solo cuando necesites una de estas tres cosas: **exhaustividad** (cubrir un repo/corpus completo), **confianza** (verificar antes de confiar) o **escala** (más de una ventana de contexto). Como dice Anthropic: *"add complexity only when it delivers measurable value"* (agregá complejidad solo cuando aporte valor medible).

```text
one agent  ──good enough?──>  ✅ done
     │ no (need coverage / confidence / scale)
     ▼
 a workflow
```

---

## 1. Inicio rápido

Podés invocar un workflow de dos maneras:

| Forma | Cuándo | Ejemplo |
|---|---|---|
| `name` | El workflow ya estaba presente al inicio de la sesión | `{ name: 'self-consistency', args: {...} }` |
| `scriptPath` (absoluto) | Es un archivo nuevo, un archivo en `drafts/` o cualquier cosa dentro de una subcarpeta | `{ scriptPath: '/Users/you/.claude/workflows/router.js', args: {...} }` |

> **La advertencia de 2 líneas.** El descubrimiento por nombre es una **foto tomada al inicio de la sesión** y **NO es recursivo** dentro de subcarpetas. Un workflow creado a mitad de sesión, o ubicado bajo `drafts/`, no va a resolver por `name`. Solución: llamalo por `scriptPath` absoluto, o creá un symlink en `~/.claude/workflows/` e iniciá una sesión nueva.

**Mínimo copy-paste:**

```js
Workflow({ name: 'complex-research', args: {
  question: 'What are the tradeoffs of WASM vs NAPI for Node FFI in 2026?'
} });
```

---

## 2. Mapa del catálogo

Los 25 workflows por **familia**. Las flechas muestran **composición** (un workflow llama a otro vía `workflow()`).

```mermaid
flowchart TB
  subgraph GG["Gate & guard"]
    CG[contract-gate]
    GR[guardrails]
  end
  subgraph RO["Route & orchestrate"]
    RT[router]
    OW[orchestrator-workers]
    MR[map-reduce]
  end
  subgraph DF["Discover & fan-out"]
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

**Cómo leerlo:** `contract-gate` puede delegar en `workflow-factory`; `router` despacha a cualquier workflow del catálogo; `guardrails` envuelve cualquier workflow; `composition-driver` llama a `verify-claims-lib`; `self-refine` puede usar `adversarial-verify` como crítico; `orchestrator-workers` funciona internamente como planner→workers→integrator; `reflexion`/`react-scout`/`bug-verify` están *grounded* (anclados en evidencia: ejecutan comandos u observaciones reales).

---

## 3. Cómo elegir un workflow

Empezá arriba y tomá la primera fila que aplique.

| Si querés… | Usá |
|---|---|
| **Acotar un pedido vago** antes de hacer nada (preguntar vs avanzar) | `contract-gate` |
| **Que elija el workflow correcto** y lo ejecute | `router` |
| **Cobertura amplia e independiente** de una work-list o repo | `fan-out-and-synthesize`, `scout-fanout`, `repo-bug-hunt` |
| **Encontrar bugs en un repo** (pistas, no confirmaciones) | `repo-bug-hunt`, `scout-fanout` |
| **Convergir en una sola respuesta** a partir de muchos caminos de razonamiento | `self-consistency` |
| **Descubrir un conjunto de tamaño desconocido** (seguir hasta secarse) | `loop-until-dry` |
| **Anclar cada paso en observaciones reales** antes de abrir ramas | `react-scout` |
| **Verificar claims / hallazgos** (podar los falsos) | `adversarial-verify`, `verify-claims-lib` |
| **Confirmar bugs de código ejecutándolos** | `bug-verify` |
| **Best of N** candidatos | `judge-escalate`, `tournament` |
| **Iterar hasta lograr calidad** sobre un solo artifact | `self-refine`, `reflexion` |
| **Explorar un espacio de soluciones** con pasos intermedios | `tree-of-thoughts` |
| **Descomponer un objetivo abierto** en un grafo de subtareas | `orchestrator-workers` |
| **Procesar un corpus enorme** que excede una ventana de contexto | `map-reduce` |
| **Imponer límites duros** alrededor de una corrida (tripwire) | `guardrails` |
| **Investigar una pregunta** con citas | `complex-research` |
| **Revisar un plan** antes de construir | `adversarial-plan-review` |
| **Aplicar una migración grande de código** con seguridad | `large-migration` |
| **Generar un workflow NUEVO** para una tarea | `workflow-factory` |
| **Componer un workflow padre + sub-workflow reutilizable** | `composition-driver` (+ `verify-claims-lib`) |

```mermaid
flowchart TD
  A[Pedido crudo] --> B{¿Ambiguo o de alto riesgo?}
  B -- sí --> CG[contract-gate]
  B -- no --> C{¿Ya sabés qué workflow?}
  C -- no --> RT[router]
  C -- sí --> D{¿Cuál es el trabajo?}
  D -- cubrir un repo/corpus --> E[fan-out / scout-fanout / repo-bug-hunt / map-reduce]
  D -- ganar confianza --> F[adversarial-verify / bug-verify / self-consistency]
  D -- elegir el mejor de N --> G[judge-escalate / tournament / tree-of-thoughts]
  D -- mejorar un artifact --> H[self-refine / reflexion / large-migration]
  D -- descomponer un objetivo --> I[orchestrator-workers]
  D -- crear un workflow nuevo --> J[workflow-factory]
```

---

## 4. Fase 0 — `contract-gate`

> **Cuándo/por qué.** Corré esto **primero**, antes de rutear o construir, cuando el pedido sea vago, tenga mucho riesgo o pueda significar dos cosas distintas. Convierte un “hacé X” en un **contrato** inspeccionable y decide la pregunta humana que importa: **¿preguntar ahora o avanzar sobre una suposición registrada?** Una especificación limpia es la palanca más grande sobre la calidad aguas abajo.

```mermaid
flowchart TD
  RAW["pedido crudo"] --> AN["Analizar: N revisores independientes + síntesis"]
  AN --> GATE{"puerta de valor de la información"}
  GATE -- "BLOCKED (impacto ALTO, sin valor por defecto seguro)" --> Q["status=NEEDS_CLARIFICATION\ndevolver questions · STOP"]
  GATE -- "PROCEED (asumir + registrar)" --> RW["Reescribir → rewrittenPrompt (improvePrompt)"]
  RW --> RP["resourcePlan (model·effort por nodo, si dynamic-workflow)"]
  RP --> HO{"¿generate=true AND routing=dynamic-workflow?"}
  HO -- sí --> WF["workflow-factory(task, name, write)"]
  HO -- no --> OUT["devolver contract + rewrittenPrompt"]
```

**Parámetros** (`request` obligatorio; aliases `task`/`text`/`question`):

| Parámetro | Por defecto | Significado |
|---|---|---|
| `reviewers` | `3` (clamp 1..5) | Reviewers independientes del contrato + síntesis; 1 = un solo análisis barato |
| `improvePrompt` | `true` | Reescribe el contrato como un `rewrittenPrompt` limpio y autocontenido; `false` reenvía el pedido crudo + contrato |
| `generate` | `false` | En PROCEED **y** `routing=dynamic-workflow`, delega en `workflow-factory` |
| `planResources` | `true` | Emite `resourcePlan` (modelo·effort sugeridos por nodo para el workflow recomendado, escalados al riesgo) |
| `maxQuestions` | `4` → ajustado a **1..3** | Tope de preguntas bloqueantes |
| `context` | `""` | Contexto adicional opcional que se adjunta al análisis + rewrite |
| `name`, `write` | — / `true` | Se pasan a `workflow-factory` al delegar |

**Devuelve:** `{ status, verdict, contract, rewrittenPrompt, questions?, routing, resourcePlan?, generated? }`, donde `verdict ∈ {PROCEED, BLOCKED}` y `status` lo refleja (`PROCEED` / `NEEDS_CLARIFICATION`).

**Ejemplo A — pedido claro → PROCEED:**
```js
Workflow({ name: 'contract-gate', args: {
  request: 'Audit packages/coding-agent/src/core for null-deref bugs and produce a cited, prioritized list.'
} });
// → { status:'PROCEED', verdict:'PROCEED', contract:{...},
//     rewrittenPrompt:'<clean self-contained spec>', routing:{ shape:'dynamic-workflow', pattern:'repo-bug-hunt', ... },
//     resourcePlan:{ tier:'balanced', pattern:'repo-bug-hunt', models:{...}, efforts:{...} } }
```

**Ejemplo B — pedido ambiguo → NEEDS_CLARIFICATION:**
```js
Workflow({ name: 'contract-gate', args: { request: 'Make the streaming faster.' } });
// → { status:'NEEDS_CLARIFICATION', verdict:'BLOCKED',
//     questions:[ { question:'Which provider path (Anthropic / OpenAI / Ollama)?', rationale:'...' },
//                 { question:'Faster by what metric — TTFB, throughput, or total latency?', rationale:'...' },
//                 { question:'What is the acceptance bar / target?', rationale:'...' } ] }   // STOP — no rewrite, no handoff
```

**Pasar `rewrittenPrompt` aguas abajo** — es el artifact durable de transferencia:
```js
const gate = Workflow({ name: 'contract-gate', args: { request: rawAsk } });
if (gate.status === 'PROCEED') {
  Workflow({ name: 'router',           args: { request: gate.rewrittenPrompt } });        // dejar que router elija + corra
  // or: Workflow({ name: 'workflow-factory', args: { task: gate.rewrittenPrompt } });    // generar un workflow nuevo
  // o pasar rewrittenPrompt a cualquier workflow específico que ya hayas elegido
}
```

---

## 5. Cómo componer

Hay exactamente **cuatro puntos de composición**. Todo lo demás es solo una llamada a `agent()`.

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

| Punto | Cómo | Ejemplo canónico |
|---|---|---|
| **a) sub-workflow** | `workflow(name, args)` dentro de un padre | `composition-driver` → `verify-claims-lib` |
| **b) wrapper** | `guardrails` con `protect:{ name, args }` | tripwire IN/OUT alrededor de cualquier corrida |
| **c) dispatch** | `router` lee el catálogo, elige uno y lo ejecuta | darle una tarea cruda |
| **d) generation** | `workflow-factory` planifica→genera→escribe un archivo nuevo | scaffold de un workflow específico para la tarea |

**Ejemplo trabajado de punta a punta** (acotar → rutear → proteger la corrida elegida):
```js
// 1) ACOTAR el pedido.
const gate = Workflow({ name: 'contract-gate', args: { request: rawAsk } });
if (gate.status !== 'PROCEED') return gate.questions;     // preguntar a la persona, parar

// 2) RUTEAR: solo recomendación, para poder envolver la elección en vez de correrla cruda.
const pick = Workflow({ name: 'router', args: {
  request: gate.rewrittenPrompt, runSelected: false       // → { selected, suggestedArgs, ... }
} });

// 3) PROTEGER: ejecutar el workflow elegido detrás de tripwires de input/output.
Workflow({ name: 'guardrails', args: {
  inputRules:  ['must stay within packages/coding-agent', 'read-only — no file writes'],
  outputRules: ['every finding cites a file:line'],
  protect: { name: pick.selected, args: pick.suggestedArgs }
} });
```

### Recursión y profundidad (el anidamiento está acotado)

La composición puede **recursar**: un workflow compuesto puede, a su vez, componer otro, e incluso un nodo puede llamar a la **Fase 0** (`workflow('contract-gate', …)`) para volver a acotar una subtarea antes de profundizar. Pero el anidamiento tiene **límite de profundidad en el runtime**:

| Runtime | Profundidad máxima | Notas |
|---|---|---|
| **Claude Code Workflow tool** | **depth-1** | el `workflow()` de un hijo lanza error: solo el **nivel superior** compone. Llamar a la Fase 0 desde adentro de un nodo sería depth-2 → acá no está permitido. |
| **pi** | **depth 2 (por defecto), configurable** | subilo vía `PI_DYNAMIC_WORKFLOWS_MAX_DEPTH` (por ejemplo `3`) → más libertad; Phase-0-from-inside funciona. |

Más allá del límite, el runtime rechaza la ejecución con un **recursion guard**. Diseñá dentro del presupuesto de profundidad; para trabajo más profundo, dejá que el orquestador ejecute los sub-workflows.

> **Referencia trabajada — `recursive-compose.js`.** Encadena exactamente esto: `contract-gate` (reacotar, depth 1) → dispatch de `router` (depth 2) → sub-llamada propia del scaffold elegido (depth 3). Es **solo para pi** y queda topeado en depth 3, así que `PI_DYNAMIC_WORKFLOWS_MAX_DEPTH>=3` lo cubre; en el runtime depth-1 de Claude Code devuelve `DEPTH_BLOCKED` en vez de romper. Además, reenvía el `resourcePlan` del gate (model/effort por nodo) hacia la corrida despachada.

---

## 6. Los 25 workflows por familia

Cada entrada: **propósito** · **usalo cuando** · **parámetros clave (valores por defecto)** · **ejemplo** · **casos de uso**.

### Gate & guard

**`contract-gate`** — gate contractual de Fase 0 (detalle completo en §4).
- *Usalo cuando:* el pedido es vago o de alto riesgo y querés decidir primero entre preguntar o avanzar.
- *Parámetros:* `request` (req) · `reviewers=3` · `improvePrompt=true` · `generate=false` · `maxQuestions=4→1..3`.
- *Casos de uso:* acotar un ticket borroso; gatear antes de una corrida multiagente costosa.

**`guardrails`** — tripwire barato de input/output que hace **HALT** ante una violación clara.
- *Usalo cuando:* necesitás imponer límites duros de forma barata alrededor de una corrida, o validar un artifact.
- *Parámetros:* `inputRules[]` / `outputRules[]` (o `rules[]`) · `content` (modo validador) · `protect:{name,args}` (modo wrapper) · `strict=false` (fail-closed: si un guard crashea, cuenta como disparado).
- *Ejemplo:*
  ```js
  Workflow({ name:'guardrails', args:{ outputRules:['no secrets in output'], content: draft } });
  ```
- *Casos de uso:* gate de alcance/seguridad antes de correr un agente; chequeo de PII/secrets sobre una salida.

### Route & orchestrate

**`router`** — clasifica un pedido y hace **dispatch** al mejor workflow del catálogo.
- *Usalo cuando:* no querés nombrar vos el workflow.
- *Parámetros:* `request` (req; aliases `task`/`text`) · `candidates?[]` · `runSelected=true` · `args?` · `context?` · `maxCandidates=60` (clamp 1..200).
- *Ejemplo:*
  ```js
  Workflow({ name:'router', args:{ request:'Audit ./src/auth for IDOR and missing checks; cited report.' } });
  // → { selected:'repo-bug-hunt', why, dispatched:true, output:<that workflow's result>, candidates:[...] }
  ```
- *Casos de uso:* una única puerta de entrada para tareas crudas; modo solo recomendación (`runSelected:false`) para previsualizar la elección.

**`orchestrator-workers`** — un **planner** descompone un objetivo abierto en un grafo de subtareas `dependsOn`, los **workers** lo ejecutan nivel por nivel (topológico, con fallas parciales visibles) y un **integrator** fusiona resultados.
- *Usalo cuando:* el objetivo es abierto y sus subtareas o forma no se conocen de antemano.
- *Parámetros:* `goal` (req; aliases `task`/`text`) · `context?` · `maxSubtasks=8` (clamp 1..30) · `concurrency?`.
- *Ejemplo:*
  ```js
  Workflow({ name:'orchestrator-workers', args:{
    goal:'Produce a launch-readiness brief: assess SSE parity, enumerate rollback triggers, draft the rollout sequence, write the exec summary.',
    maxSubtasks:6, concurrency:3, efforts:{ planner:'xhigh', integrator:'high' } } });
  // → { result, plan:{ subtasks:[{id,description,dependsOn}], schedule, ... }, workers:[{id,status,output}] }
  ```
- *Casos de uso:* entregables de varias partes; objetivos de investigación/construcción con interdependencias.

**`map-reduce`** — map-reduce jerárquico (recursivo): **map** por chunk bajo un contrato de evidencia → **reduce** en lotes acotados hasta que quede un único resumen-de-resúmenes.
- *Usalo cuando:* la entrada es más grande que una ventana de contexto.
- *Parámetros:* `instruction` (req) · `items?[]` **o** `content?` (uno obligatorio; `items` gana) · `chunkChars=8000` (500..200000) · `reduceBatch=5` (2..20) · `maxChunks=400` (1..2000) · `maxRounds` adaptativo.
- *Ejemplo:*
  ```js
  Workflow({ name:'map-reduce', args:{
    instruction:'Extract every breaking API change with affected symbol + one-line migration note; cite the span.',
    content: veryLongChangelog, chunkChars:6000, reduceBatch:4 } });
  // → { result, chunks, mapCount, reduceRounds }
  ```
- *Casos de uso:* resumir un doc/log enorme; consolidar cientos de tickets.

### Discover & fan-out

**`fan-out-and-synthesize`** — patrón base scatter-gather: scout de una work-list → un reviewer por ítem (parallel, settle) → synthesize-as-judge con notas de cobertura/falla.
- *Usalo cuando:* necesitás cobertura amplia e independiente de una work-list más o menos conocida.
- *Parámetros:* `limit=12` · `pattern='code'` (preset `code|docs|web|config` o regex cruda) · `lens='code'` (preset `code|security|prose` o texto libre) · `files?[]`.
- *Ejemplo:* `Workflow({ name:'fan-out-and-synthesize', args:{ lens:'security', limit:20 } });`
- *Casos de uso:* repartir una review entre muchos archivos; síntesis multiángulo.

**`scout-fanout`** — scout → pipeline de **adaptive-depth**: clasifica riesgo de *cada* archivo de forma barata y hace deep-review solo en los de riesgo alto/medio; los de riesgo bajo cortan antes.
- *Usalo cuando:* querés cobertura, pero pagar solo por los ítems riesgosos.
- *Parámetros:* `pattern='code'` · `lens='code'` · `maxFiles=40` (clamp 1..200) · `files?[]`.
- *Ejemplo:* `Workflow({ name:'scout-fanout', args:{ pattern:'config', lens:'security' } });`
- *Casos de uso:* triage y review sobre un árbol grande; pasadas de classify-and-act.

**`repo-bug-hunt`** — scout de archivos de código → reviewers de bugs por archivo → judge que deduplica y prioriza con citas. **Los hallazgos son pistas, no bugs confirmados.**
- *Usalo cuando:* querés una lista priorizada y citada de bugs sospechosos en un repo.
- *Parámetros:* `files?[]` · `maxFiles=40` · `concurrency=6` · `pattern='code'` · `lens='code'`.
- *Ejemplo:* `Workflow({ name:'repo-bug-hunt', args:{ maxFiles:30, lens:'security' } });`
- *Casos de uso:* auditoría de repo; barrida previa a review (después confirmá con `bug-verify`).

**`loop-until-dry`** — seguí abriendo ramas de búsqueda hasta **K rondas consecutivas silenciosas** o `maxRounds`.
- *Usalo cuando:* el conjunto que estás descubriendo tiene tamaño desconocido y querés exhaustividad.
- *Parámetros:* `target`/`scope`/`task` (req) · `quietRounds=2` · `maxRounds=8` · `finders=3` (clamp 1..6).
- *Ejemplo:* `Workflow({ name:'loop-until-dry', args:{ target:'all places we parse SSE chunks', quietRounds:2 } });`
- *Casos de uso:* enumerar todos los call-sites/edge-cases; “encontrá todo lo que…”.

**`react-scout`** — loop ReAct reason→act→observe: cada paso ancla un pensamiento en una **observación real read-only** antes del siguiente.
- *Usalo cuando:* necesitás un scout basado en evidencia antes de commitear o abrir ramas.
- *Parámetros:* `question` (req; aliases `q`/`text`/`topic`) · `maxSteps=6` (clamp 1..50) · `tools=['read','grep','find','ls','web_search']`.
- *Ejemplo:* `Workflow({ name:'react-scout', args:{ question:'Where does the WASM decoder get fed bytes?' } });`
- *Casos de uso:* investigación fundamentada; producir `result.trace` para entregárselo a un fan-out.

**`complex-research`** — ángulos de investigación independientes (cada uno corre web search) → synthesize-as-judge con citas y huecos de cobertura.
- *Usalo cuando:* necesitás una respuesta con citas para una pregunta externa.
- *Parámetros:* `question` (req; aliases `q`/`text`) · `angles?[]` (por defecto 4: fuentes primarias / opciones y tradeoffs / riesgos y migración / mejor recomendación).
- *Ejemplo:* `Workflow({ name:'complex-research', args:{ question:'WASM vs NAPI FFI for Node in 2026?' } });`
- *Casos de uso:* comparaciones tecnológicas; scans de literatura/paisaje. *Combiná con un paso de verify para respuestas de alto impacto.*

### Verify

**`adversarial-verify`** — **skeptic jury** por hallazgo que poda por refutación mayoritaria; duda por defecto.
- *Usalo cuando:* tenés findings/claims y querés quedarte solo con los que sobreviven a la refutación.
- *Parámetros:* `findings?[]` (si no, se descubren desde `topic`) · `skeptics=3` (clamp 1..99) · `maxFindings=8`.
- *Ejemplo:* `Workflow({ name:'adversarial-verify', args:{ topic:'security claims about our token flow', skeptics:5 } });`
- *Casos de uso:* podar una lista ruidosa de hallazgos; sanity-check de claims antes de actuar.

**`bug-verify`** — confirma bugs sospechosos por **REPRODUCTION**: un bug es real solo si una corrida falla de verdad sobre el código actual; opcionalmente chequea FAIL→PASS después de un fix y minimiza el caso.
- *Usalo cuando:* necesitás *probar* un bug, no solo argumentarlo. Corre **secuencialmente** sobre el working tree.
- *Parámetros:* `bugs?[]` **o** `topic` · `verifyCmd` (por ejemplo `"npm test"`) · `attemptFix=false` · `minimize=false` · `maxBugs=12`.
- *Ejemplo:* `Workflow({ name:'bug-verify', args:{ topic:'SSE decoder drops final chunk', verifyCmd:'npm test', attemptFix:true } });`
- *Casos de uso:* confirmar pistas de `repo-bug-hunt`; loop de reproducir-y-arreglar.

**`verify-claims-lib`** — **sub-workflow** reutilizable: verifica `{claims, skeptics?}` con skeptic juries.
- *Usalo cuando:* un workflow padre necesita verificación como bloque de construcción.
- *Parámetros:* `claims[]` (req) · `skeptics=3` (clamp 1..64) · `topic?`.
- *Devuelve:* `{ verified, dropped, votes, coverage }`.
- *Casos de uso:* lo llama `composition-driver`; cualquier workflow padre que primero descubre y luego verifica.

**`adversarial-plan-review`** — N reviewers de ángulo fijo (correctness, security, maintainability, scope) → synthesize de un plan revisado.
- *Usalo cuando:* querés tensionar un plan antes de construir.
- *Parámetros:* `plan`/`text` (req). El fan-out queda topeado en 4 reviewers; si todos fallan → `INSUFFICIENT_EVIDENCE`.
- *Ejemplo:* `Workflow({ name:'adversarial-plan-review', args:{ plan: theImplementationPlan } });`
- *Casos de uso:* review de diseño/RFC; gate previo a implementación.

### Generate & select

**`judge-escalate`** — genera candidatos desde ángulos distintos → judge tipado → **escala solo cuando la confianza es baja**.
- *Usalo cuando:* hacés best-of-N y preferís profundizar antes que comprometerte con un ganador débil.
- *Parámetros:* `question` (req; aliases `q`/`text`) · `angles=['risk-first','simplicity-first','user-first']` (max 8) · `maxEscalations=2`.
- *Ejemplo:* `Workflow({ name:'judge-escalate', args:{ question:'Best rollback strategy for the gate?' } });`
- *Casos de uso:* decisiones con un ganador claro la mayor parte del tiempo; gasto adaptativo.

**`tournament`** — cuadro de eliminación simple: rondas de judge por pares hasta que sobrevive uno (`ceil(log2 n)` rondas; si el tamaño es impar, uno pasa de ronda).
- *Usalo cuando:* el scoring absoluto no es confiable, pero comparar de a pares sí.
- *Parámetros:* `candidates?[]` (si no, se generan desde `angles`) · `topic?` · `angles=['risk-first','simplicity-first','user-first','cost-first']`.
- *Ejemplo:* `Workflow({ name:'tournament', args:{ candidates:[a,b,c,d] } });`
- *Casos de uso:* elegir el mejor entre varios borradores/diseños mediante enfrentamientos directos.

**`self-consistency`** — samplea N caminos de razonamiento independientes → elige la respuesta por **consensus** (vote), con desempate de un judge que pondera evidencia.
- *Usalo cuando:* una sola cadena podría equivocarse y la señal en la que confiás es el acuerdo.
- *Parámetros:* `question` (req; aliases `q`/`text`) · `samples=5` (clamp 2..20). Los samplers corren con `cache:false` para lograr independencia real.
- *Ejemplo:* `Workflow({ name:'self-consistency', args:{ question:'Does this code path leak the handle?', samples:7 } });`
- *Casos de uso:* razonamiento/matemática/juicio de alta varianza; reportar el margen del consenso.

**`tree-of-thoughts`** — beam-search sobre soluciones parciales: expandir K thoughts → judge-score → podar a top-B → recursar en profundidad → commit.
- *Usalo cuando:* el problema tiene **pasos intermedios** que vale la pena explorar, no solo candidatos finales.
- *Parámetros:* `problem` (req; aliases `question`/`text`/`task`) · `branching=3` (clamp 2..8) · `beam=2` (clamp 1..16) · `depth=3`.
- *Ejemplo:* `Workflow({ name:'tree-of-thoughts', args:{ problem:'Design the gate rollout in 4 staged steps.' } });`
- *Casos de uso:* búsqueda de diseño/planificación multi-paso; `judge-escalate` es esto con depth=1 y beam=1.

### Iterate & refine

**`self-refine`** — ciclo acotado generate→critique→refine sobre el mismo lugar, con memoria verbal; frena en silencio cuando el crítico queda satisfecho.
- *Usalo cuando:* querés pulir **un** artifact y la crítica puede ser intrínseca.
- *Parámetros:* `task` (req; aliases `question`/`text`) · `maxRounds=4` · `useJury=false` (cambia el crítico por el jury de `adversarial-verify` — una señal independiente más fuerte) · `skeptics=3` (tamaño del jury, usado cuando `useJury`).
- *Ejemplo:* `Workflow({ name:'self-refine', args:{ task:'Write the migration guide section.', useJury:true } });`
- *Casos de uso:* pulido de docs/spec/código cuando el retorno marginal cae rápido.

**`reflexion`** — loop externo de verbal-RL por intentos: reintenta la tarea completa en cada trial, llevando un buffer acotado de autorreflexiones; el evaluador puede estar **anclado externamente** (corre `verifyCmd`).
- *Usalo cuando:* un reintento fresco rinde más que editar sobre lo ya hecho, y tenés un oráculo objetivo.
- *Parámetros:* `task` (req; aliases `question`/`text`) · `verifyCmd?` (ancla el evaluador) · `maxTrials=3` · `memoryCap=3` · `actorModel?` / `evaluatorModel?`.
- *Ejemplo:* `Workflow({ name:'reflexion', args:{ task:'Make the failing decoder test pass.', verifyCmd:'npm test -- decoder' } });`
- *Casos de uso:* código con tests; tareas con señal pass/fail. (Se distingue de `self-refine`: resetear y reintentar vs editar en el lugar.)

**`large-migration`** — un **applier** real: gate de baseline en verde → apply→verify→bounded-repair por archivo → **rollback on failure**. Secuencial sobre el working tree.
- *Usalo cuando:* vas a mutar muchos archivos y no podés dejar ninguno roto.
- *Parámetros:* `instruction` (req; aliases `task`/`text`) · `files?[]` **o** `pattern` (por defecto: extensiones de código) · `verifyCmd` · `maxRepairs=2` · `maxFiles=50` · `triage=true` · `dryRun=false`.
- *Ejemplo:* `Workflow({ name:'large-migration', args:{ instruction:'Replace X(...) with Y(...)', verifyCmd:'npm run build && npm test', dryRun:true } });`
- *Casos de uso:* despliegues de API/codemod; upgrades de framework.

### Compose & meta

**`composition-driver`** — workflow padre: descubre claims → delega la verificación a `verify-claims-lib` → sintetiza.
- *Usalo cuando:* querés un ejemplo trabajado de workflow padre + sub-workflow reutilizable, o exactamente ese flujo descubrir→verificar.
- *Parámetros:* `topic` (req; aliases `question`/`text`) · `maxClaims=8` (clamp 1..20) · `skeptics=3`.
- *Ejemplo:* `Workflow({ name:'composition-driver', args:{ topic:'claims in our SSE parity doc' } });`
- *Casos de uso:* fact-check de un documento; referencia canónica de composición.

**`workflow-factory`** — meta: catálogo → plan → generar → review → refine → **write** `.claude/workflows/drafts/<slug>.js`.
- *Usalo cuando:* no encaja ningún workflow existente y querés que te scaffoldee uno específico para la tarea.
- *Parámetros:* `task` (req; aliases `request`/`text`) · `name?` (slug) · `write=true` (`false` devuelve solo el JS).
- *Ejemplo:* `Workflow({ name:'workflow-factory', args:{ task:'Audit GraphQL resolvers for N+1 queries and emit a cited report.' } });`
- *Casos de uso:* bootstrap de un patrón nuevo; especializar el scaffold existente más cercano. **La salida es un draft: inspeccionalo antes de confiarle trabajo costoso o mutante.**

**`recursive-compose`** — REFERENCIA (pi, depth≤3): un nodo vuelve a gatear una subtarea vía el `contract-gate` de Fase 0 y después despacha el scaffold recomendado vía `router` — composición recursiva acotada.
- *Usalo cuando:* querés el patrón trabajado de **Phase-0-from-inside** + dispatch recursivo.
- *Parámetros:* `task` (req; aliases `request`/`text`) · `context?` · `args?` (se reenvía al workflow elegido).
- *Ejemplo:* `Workflow({ name:'recursive-compose', args:{ task:'audit + fix the SSE decoder' } });` *(pi; en el runtime depth-1 de Claude Code, el nested dispatch devuelve `DEPTH_BLOCKED`)*
- *Casos de uso:* pipelines auto-similares gate→compose; arrastrar el presupuesto de `resourcePlan` del gate a una corrida más profunda.

---

## 7. Model, effort, tools y skills por nodo

> **Cuándo/por qué.** Cada workflow enruta cada llamada a agente (“nodo”) a través de un helper `node(role, extra)`, así que podés definir **model**, **reasoning effort**, **tools** y **skills** por nodo desde el input, sin tocar código. Gastá presupuesto donde paga (judges/verifiers/synthesis), mantené baratos los scouts y limitá cada nodo a las tools/skills que realmente necesita.

- `model` / `effort` — **valores por defecto globales** que se aplican a cada nodo (por ejemplo `{ "effort": "low" }`).
- `models` / `efforts` — **overrides por rol** indexados por nombre de rol (por ejemplo `{ "models": { "synthesis": "opus" } }`).
- `tools` / `skills` — allowlists **globales** y `excludeTools` como denylist **global** (arrays) aplicadas a cada nodo.
- `toolsByRole` / `skillsByRole` / `excludeByRole` — **overrides por rol** (maps `role → array`).
- **Precedencia (todos los knobs):** override por rol > valor por defecto global > valor por defecto del call-site horneado en el archivo.
- `effort ∈ low | medium | high | xhigh | max`; `model ∈ haiku | sonnet | opus | fable` o un model id completo.

```json
{ "models": { "scout": "haiku", "synthesis": "opus" }, "efforts": { "scout": "low", "synthesis": "high" },
  "tools": ["read", "grep", "find", "ls"], "toolsByRole": { "migrate": ["read", "edit", "bash"] },
  "skillsByRole": { "synthesis": ["/path/to/skill"] } }
```

El helper es byte-identical en todos los archivos:
```js
const node = (role, extra = {}) => {
  const o = { label: role, ...extra };
  const m = models[role] ?? input?.model;        if (m != null) o.model = m;
  const e = efforts[role] ?? input?.effort;      if (e != null) o.effort = e;
  const t = toolsByRole[role] ?? input?.tools;          if (Array.isArray(t)) o.tools = t;
  const s = skillsByRole[role] ?? input?.skills;        if (Array.isArray(s)) o.skills = s;
  const x = excludeByRole[role] ?? input?.excludeTools; if (Array.isArray(x)) o.excludeTools = x;
  return o;
};
```

> **⚠️ Advertencia de runtime para `tools`/`skills`/`excludeTools`.** El **tool/skill scoping por agente sí se hace cumplir bajo el runtime de pi** (donde es una opción documentada del agente): ahí sandboxea de verdad cada nodo. En el **Claude Code Workflow runtime es solo orientativo / no enforced** (está verificado: un subagente con scope siguió teniendo acceso completo a archivos), aunque `model`/`effort` **sí** se respetan. Entonces, tratá tools/skills como intención + enforcement en pi, no como un límite de seguridad en Claude Code.

### Claves de rol por workflow — `role → valor sugerido (model · effort)`

| Workflow | Roles → valor sugerido |
|---|---|
| `adversarial-plan-review` | `reviewer` (sonnet·medium), `plan-synthesis` (opus·high) |
| `adversarial-verify` | `finder` (haiku·low), `skeptic` (opus·high) |
| `bug-verify` | `finder` (haiku·low), `tree-baseline` (haiku·low), `repro` (sonnet·medium), `tree-check` (haiku·low) |
| `complex-research` | `research` (haiku·low), `research-synthesis` (opus·high) |
| `composition-driver` | `claim-finder` (haiku·low), `composition-synthesis` (opus·high) |
| `contract-gate` | `analyze` (sonnet·medium), `analyze-contract` (sonnet·medium), `analyze-synthesis` (opus·high), `rewrite-prompt` (sonnet·medium), `resource-plan` (sonnet·medium) |
| `fan-out-and-synthesize` | `scout` (haiku·low), `review` (sonnet·medium), `synthesis` (opus·high) |
| `guardrails` | `input-guard` (haiku·low), `output-guard` (haiku·low) |
| `judge-escalate` | `cand` (sonnet·medium), `judge` (opus·high), `synthesis` (opus·high) |
| `large-migration` | `scout` (haiku·low), `baseline` (haiku·low), `recheck` (haiku·low), `migrate` (sonnet·medium), `final-verify` (haiku·low) |
| `loop-until-dry` | `finder` (haiku·low), `synthesis` (opus·high) |
| `map-reduce` | `mapper` (haiku·low), `reducer` (sonnet·medium) |
| `orchestrator-workers` | `planner` (opus·high), `worker` (sonnet·medium), `integrator` (opus·high) |
| `react-scout` | `reason` (sonnet·medium), `observe` (haiku·low), `answer` (opus·high) |
| `recursive-compose` | *(sin claves de rol propias — composición recursiva acotada; delega en `contract-gate`/`router`, cuyas filas aplican)* |
| `reflexion` | `actor` (sonnet·medium), `evaluator` (opus·high), `reflection` (opus·high) — además `actorModel`/`evaluatorModel` |
| `repo-bug-hunt` | `scout` (haiku·low), `bug-hunt` (sonnet·medium), `synthesis` (opus·high) |
| `router` | `catalog-scan` (haiku·low), `route` (opus·high) |
| `scout-fanout` | `scout` (haiku·low), `classify` (haiku·low), `deep` (sonnet·medium), `synthesis` (opus·high) |
| `self-consistency` | `sample` (haiku·low), `tiebreak` (opus·high) |
| `self-refine` | `draft` (sonnet·medium), `critique` (opus·high), `refine` (sonnet·medium) |
| `tournament` | `seed` (sonnet·medium), `match` (opus·high) |
| `tree-of-thoughts` | `expand` (sonnet·medium), `score` (opus·high), `commit` (opus·high) |
| `verify-claims-lib` | `skeptic` (opus·high) |
| `workflow-factory` | `catalog-scan` (haiku·low), `workflow-plan` (opus·high), `workflow-codegen` (sonnet·medium), `workflow-review` (sonnet·medium), `workflow-refine` (sonnet·medium), `write-file` (haiku·low) |

> `contract-gate` también puede **sugerir** toda esta tabla para el workflow recomendado vía `resourcePlan` (`{ tier, models, efforts }`): hacé splat en la corrida aguas abajo u overridealo.

### Models y effort cross-provider (Codex / OpenAI)

Los valores de arriba son para el **Claude Code Workflow runtime**, donde `model` es solo de Claude (`haiku | sonnet | opus | fable`). El **runtime de pi** resuelve `provider/id[:thinking]`, así que los mismos knobs también pueden apuntar a **OpenAI Codex**:

```json
{ "models": { "synthesis": "openai-codex/gpt-5.6-sol", "judge": "openai-codex/gpt-5.6-sol" },
  "efforts": { "synthesis": "xhigh", "judge": "high" } }
```

| Modelo Codex (mediados de 2026) | Notas |
|---|---|
| `gpt-5.6-sol` | modelo de frontera para síntesis, juicio y coding agéntico complejo |
| `gpt-5.6-terra` | tier equilibrado para workers de razonamiento normal |
| `gpt-5.6-luna` | tier económico para scouting, extracción y alto volumen |
| `gpt-5.3-codex-spark` | opción especializada disponible en el selector de Codex |

**Esfuerzo de razonamiento** (Codex `low · medium · high · xhigh`) se alinea 1:1 con nuestro `effort`. *medium* es el caballo de batalla diario; *xhigh* piensa más tiempo.

> **Advertencia de runtime:** los nombres de modelo de Claude (`haiku`/`sonnet`/`opus`/`fable`) aplican bajo el runtime de Claude Code; los nombres tipo `provider/id` como los ids de Codex aplican solo al correr bajo **pi**.

---

## 8. Convenciones de runtime y autoría

> **Cuándo/por qué.** Leé esto antes de editar o escribir un workflow: el runtime inyecta helpers y hace cumplir algunas reglas duras.

**Checklist de convenciones:**
- ✅ Solo helper-globals: `agent`, `parallel`, `pipeline`, `workflow`, `phase`, `log`, `args`. **No** `import` / `require` / `ctx.*` / globals de Node.
- ✅ `agent(promptString, opts)` — **primero string**, después opciones (`{ label, phase, effort, schema, cache, model, tools, skills, excludeTools }`). Nunca `agent({ prompt })`.
- ✅ Con `{ schema }` → devuelve el **parsed object**; sin eso → el **text string**.
- ✅ `args` llega **JSON-stringified**: parsealo de forma defensiva con `typeof args === "string" ? JSON.parse(args) : (args || {})`.
- ✅ En `agent({ schema })`, el tipo top-level **MUST be `object`**: envolvé arrays dentro de un objeto.
- ✅ Enrutá cada llamada a agente a través de `node(role, extra)`; mantené estables los nombres de rol (son las keys de `models`/`efforts`).
- ✅ `parallel([thunks])` es una barrera; usá semántica de **settle** para que una rama que crashea resuelva a `null` en vez de hundir la ronda.
- ✅ Cada loop está **acotado por ambos lados** (tope duro + condición de silencio/satisfacción). **Nada de topes silenciosos**: llamá a `log()` cada vez que hagas clamp o drop.
- ✅ `meta.name` debe ser igual al filename; mantené `meta` como literal puro.
- ✅ **Basalo en el scaffold más cercano y declaralo como procedencia**: `meta.basedOn` es un array de literales `{ name, role }`, uno por cada scaffold reutilizado/especializado/compuesto (por ejemplo `meta.basedOn = [{ name: 'fan-out-and-synthesize', role: 'scatter-gather base' }]`). Esto llena la pestaña **Based-on** del artifact (lee `meta.basedOn` como string o como array `[{name, role?, desc?}]`; si no, cae a un comentario inicial `Paper:/Based on:/Source:`); usá `[]` solo si realmente se construyó desde cero.

**Cómo autorar uno nuevo:** **basalo en el scaffold existente más cercano — no reinventes — y registralo en `meta.basedOn`.** No lo armes a mano: corré **`workflow-factory`** con un `task`. Lee el catálogo, prefiere reutilizar/especializar el scaffold más cercano, compone subpasos reutilizables vía `workflow()` y escribe un draft en `.claude/workflows/drafts/<slug>.js`. Inspeccioná/editá el draft y después creá un symlink o renombralo dentro de `~/.claude/workflows/`; luego iniciá una sesión nueva para que resuelva por `name`.

```mermaid
flowchart LR
  T[task] --> WF[workflow-factory]
  WF --> D["drafts/&lt;slug&gt;.js"]
  D --> I[inspect / edit]
  I --> P[promote to ~/.claude/workflows]
  P --> S[new session → resolves by name]
```
