# Plan: paridad de la extensión Pi con los Claude Dynamic Workflows

Fecha: 2026-06-25
Estado base: `extensions/dynamic-workflows.ts` (2945 líneas, commit `9ea1924`, con resume/idempotencia ya implementado).
Método: workflow de auditoría + feasibility contra el SDK real de pi (`node_modules/@earendil-works/*`, `pi --help`) + diseño por feature + síntesis (14 subagentes).

> Actualización de implementación (2026-06-25): el estado base de este plan es histórico. En el árbol actual ya están implementados `agents({settle:true})`, `ctx.parallel`, `ctx.pipeline`, `agent({schema})`, `agentType`, `--mode json`, runs background/resume, dashboard TUI monitor-first y el router ultracode always-on que instruye crear workflows dinámicos bajo `generated/<slug>`. Siguen fuera de este corte `ctx.workflow()`, budget tokens/coste, aislamiento por worktree y determinismo estricto. La verificación local canónica es `npm test`; además se smokeó un workflow generado `generated/runtime-smoke` con `run` y `start`.

## Contexto

Tras implementar runs reanudables/idempotentes, el objetivo es llevar la extensión a paridad con
"todo lo bueno" de los Claude Dynamic Workflows. Este plan parte de una auditoría del código actual y
de una verificación de qué soporta realmente `pi -p`, para no diseñar sobre supuestos.

**Hallazgo de feasibility load-bearing:** `pi -p` soporta `--mode text|json|rpc`. El modo `json` emite
JSON Lines con `Usage` (incluido costo USD) por mensaje. Esto es la **pieza maestra**: habilita a la vez
el **structured output** (parseo confiable de la salida del asistente) y el **budget de tokens/coste**
(medición exacta, no estimada). En cambio, `pi -p` **no** tiene `--output-schema`/`response_format`, así
que el structured output es prompt-engineering + parseo + validación host-side (no decodificación
restringida) — de ahí su `feasibility: medium`.

## 1. Veredicto: dónde está Pi hoy vs. Claude

Pi ya tiene el **núcleo difícil resuelto**; lo que falta son **primitivas de composición y tipado**, no fundamentos.

**Pi ya logra (paridad o superior):**
- **Resume/idempotencia content-address**: `computeCallKey` + `nextOcc`/`occCounters` + `journal.jsonl` + `writeJsonFile` atómico; `agent()` cacheado por defecto, `bash()` opt-in. Más explícito que el auto-persist de Claude.
- **Concurrencia acotada**: `createSemaphore` global + `mapLimit`, tope `min(16, cores-2)`.
- **Background + notificación**: `activeRuns`, `AbortController` por run, `wakeAgentForWorkflowResult`.
- **UX**: dashboard TUI (3 tabs), status line, widget live, grafo Mermaid, runs/view — más rica que la de Claude.
- **Sandbox aislado**: Worker + `vm.createContext` con bridge `hostCall` y `allowedMethods` allowlist.

**Pi NO tiene (gaps verificados):**

| Claude | Estado Pi | Evidencia |
|---|---|---|
| `agent(prompt,{schema})` → objeto validado + reintento | ❌ `SubagentResult.output` siempre TEXTO | l.113-125 |
| `parallel(thunks)` null-on-failure | ❌ `agents()` = `Promise.all` (hard-fail al 1er error) | l.589 |
| `pipeline(items, ...stages)` sin barrera | ❌ solo `agents()` map-barrera | l.2093 |
| `workflow(name, args)` composición | ❌ 1 worker por run; no en allowlist | l.890 |
| `budget{spent(),remaining()}` | ❌ solo concurrency/maxAgents/timeout | l.84-90 |
| `isolation:'worktree'` | ❌ todos comparten `ctx.cwd` | l.2028 |
| Guardas determinismo (Date/Math) | ❌ intrínsecos del vm vivos | sandbox l.835-853 |
| `agentType`/persona | ❌ no existe | l.92-107 |

**Bug de fondo (correctitud):** `appendJournalRecord` (l.1276) y `appendEvent` (l.1925) usan `fs.appendFile`
crudo sin serializar; con `agents()` concurrente y streams grandes (hasta `MAX_JOURNALED_STREAM=200_000`)
pueden intercalarse, y `loadJournal` descarta en silencio líneas malformadas en el medio → **re-ejecuta
agentes ya completados en resume** (pérdida de tokens/trabajo).

## 2. Tabla de gaps

| # | Feature | Value | Effort | Feasibility | Depende de |
|---|---|---|---|---|---|
| A | **parallel() + agents({settle})** null-on-failure | Alto | **S** | easy | — |
| B | **Fixes robustez resume** (mutex append, truncado uniforme, occ↔id) | Alto (correctitud) | M | easy | — |
| C | **pipeline(items, ...stages)** worker-side | Alto | M | easy | A |
| D | **agentType/persona registry** | Alto | M | easy | — |
| E | **Guardas determinismo** ctx.now/random + freeze opt-in | Alto | M | easy | runId/started (ya existen) |
| F | **structured output** agent({schema}) | Alto | M | **medium** | typebox (ya dep) |
| G | **budget** tokens/coste (`--mode json`) | Alto | M | **medium** | comparte parser con F |
| H | **workflow(name, args)** sub-workflows | Alto | M | easy | refactor `spawnWorkflowWorker` + occNamespace |
| I | **isolation:'worktree'** | Alto | M | easy | git CLI, `isProjectTrusted` |

## 3. Roadmap por fases

### P0 — Fundaciones (primero; baratas, sin dependencias, multiplican el resto)

- **P0.1 — Fixes de robustez del resume (B).** Va primero porque es correctitud: subir la concurrencia
  (parallel/pipeline) sin esto empeora el torn-write.
  - `AsyncMutex` + `Map<path,AsyncMutex>` envolviendo `appendJournalRecord` (l.1276) y `appendEvent` (l.1925).
  - Unificar truncado: `result.output` usa `slice` (l.2037) vs journal `truncate` (l.2065) → el HIT devuelve
    copia más corta que el run fresco. Unificar para garantizar **resume == fresh**. Bump `JOURNAL_VERSION`.
  - `loadJournal` (l.1263): warning para corrupción mid-file, tolerar solo tail (torn por crash).
- **P0.2 — parallel() + agents({settle}) (A).** Effort S, opt-in (riesgo ~nulo). Que un fan-out de 20 ramas
  no se caiga entero por 1 crash duro. Desbloquea adversarial-verify / judge-panel.
  - `mapLimit` (l.580): param `onError:'throw'|'null'` (default throw); `throwIfAborted` **fuera** del try
    (cancel/timeout global siempre propaga).
  - `agents()`: `opts.settle?` → `Array<SubagentResult|null>`. `parallel(thunks)`: **worker-side** (los thunks
    no cruzan el bridge), semáforo local, `try/catch`→null. No toca `allowedMethods`.

### P1 — Expresividad y tipado (el grueso de la paridad)

- **P1.1 — structured output (F).** La más pedida; habilita judge-panel/classify/extract/completeness-critic
  con objetos tipados. Se integra gratis con resume (`schema` es JSON plano → entra en `sanitizeAgentOpts` y
  `computeCallKey`). Rama `if(options.schema)` en `runSubagent`: instrucción + schema vía `--append-system-prompt`
  (concatenar si ya hay uno); `extractJsonCandidate` (parse→fence→balance) + validación TypeBox (`Value.Check`);
  bucle `schemaRetries` (default 2) realimentando errores; extender `SubagentResult` con `data?/schemaOk?`.
  Contrato: **JSON Schema plano** (TSchema con symbols no sobrevive el `structuredClone` del bridge).
- **P1.2 — pipeline() (C).** Worker-side puro (stages = funciones). Cadena de promesas por item, todas
  arrancan juntas, `Promise.allSettled`, `try/catch`→null; concurrencia real gobernada por `agentSemaphore`.
  Riesgo: colisión de cache-key si dos items dan prompt idéntico → forzar/documentar índice del item en el prompt.
- **P1.3 — agentType/persona (D).** 100% factible con flags ya soportados. `applyPersona(options, persona)` que
  mergea como DEFAULTS (override del caller gana) **antes de `computeCallKey`**; `agentType` crudo NO va en la key
  (quitarlo en `sanitizeAgentOpts`). Built-ins: explore/reviewer/planner/implementer/researcher. `.pi/personas/` si trusted.

### P2 — Avanzadas (mayor superficie/riesgo)

- **P2.1 — budget (G).** `--mode json` en `runSubagent` (l.2007) + parser JSONL para `Usage.cost`. Riesgo
  compartido con F: cambia el stdout → hay que reconstruir `output` desde el último assistant message o se rompe
  `.output` de todos los workflows. `ctx.budget` síncrono via espejo en el worker; acumulador persistido (`baseSpent`).
- **P2.2 — guardas determinismo (E).** Capa 1 (aditiva, siempre on): `ctx.now()/random()/uuid()` sembrados por
  `sha256(runId)`. Capa 2 (`determinism:'off'|'seed'|'strict'`, **default `'seed'`**): PRELUDE en el vm que
  reemplaza `Date`/`Math.random`/`crypto` por las versiones sembradas; `'off'` restaura los globales reales
  (opt-out). Reusar `started` original en resume como epoch base.
- **P2.3 — workflow() sub-workflows (H).** Refactor `executeWorkflowCode` → `spawnWorkflowWorker(code,input,api,...)`;
  el hijo comparte la misma `api` (semáforo/journal/abort gratis). Añadir `workflow` a `allowedMethods`; guard
  `depth<=1` host-side; `occNamespace` para no colisionar journal padre/hijo.
- **P2.4 — isolation:'worktree' (I).** `git worktree add --detach` lazy en `runSubagent` antes de `pi.exec`; `cwd`
  = worktree; cleanup en el `finally` de `runWorkflow`. Trampa única: excluir `isolation*` de la cache-key en
  `sanitizeAgentOpts` o el path efímero envenena el resume.

## 4. Decisiones resueltas

Resueltas con evidencia del SDK real (workflow `resolve-decisions`: D1/D2/D3/D6 con tests empíricos de typebox y `pi -p --mode json`; D4/D5 cerradas por análisis). Todas con default accionable.

| id | Decisión | Resolución | Confianza |
|---|---|---|---|
| D1 | Retorno de structured output | **`SubagentResult.data?` + `.schemaOk?`** (sin `ctx.agentData` aún; agregable después sin romper tipos) | alta |
| D2 | Validador de schema | **typebox `Value.Check` (sin `ajv`)**; documentar subset; `allOf`→Intersect, `oneOf`→Union, `Not`→Exclude | alta |
| D3 | `--mode json` global vs gated | **Migrar TODO** + reconstruir `.output` (concatenar `text` del último assistant); bump `JOURNAL_VERSION` | alta |
| D4 | Ubicación de worktrees | **`os.tmpdir()/pi-wf-<runId>/`** (fuera del repo); cleanup `git worktree remove --force` en `finally` | alta |
| D5 | Default de determinismo | Capa 1 (`ctx.now/random/uuid` sembrados) siempre on; Capa 2 (freeze `Date`/`Math`) **default `'seed'`** (opt-out `'off'`) | alta |
| D6 | Eval de sub-workflows | **HOST eval** con ctx-hijo que reusa semáforo/journal/agentCount/signal (NO anidar Worker) | alta |

**Fundamento:**
- **D1 — `.data` en `SubagentResult`.** Un solo tipo de resultado → cohesión; `ctx.agents()` funciona sin variante; el journal persiste `data` sin cambios; workflows sin schema ignoran `.data` null. `ctx.agentData()` queda como azúcar opcional posterior.
- **D2 — typebox solo.** Tests empíricos: `Value.Check` cubre objects/arrays/enums/unions/`$ref`/format/pattern/if-then-else/nested/Tuple; ~2-4× más rápido que ajv; ya es dependencia. Los huecos (allOf/oneOf/Not puros, dynamicRef/unevaluatedItems de 2020-12) se evitan refactorizando o no aparecen en structured output típico.
- **D3 — migrar todo a `--mode json`.** Prerequisito de F y G; gatearlo crea dos caminos (deuda + falso cache-hit por flag). `.output` se reconstruye filtrando `agent_end` → concatenar `content[type=text].text` (verificado: idéntico al baseline). `.output` NO entra en la cache-key → seguro en resume. *Es el cambio más transversal: re-testear los ejemplos.*
- **D4 — worktrees en `os.tmpdir()`.** Fuera del árbol trackeado → sin riesgo de anidar repos ni depender de `.gitignore`; `git worktree add --detach <tmp>`; cleanup best-effort en el `finally` de `runWorkflow`; excluir `isolation*` de la cache-key (`sanitizeAgentOpts`).
- **D5 — determinismo default `'seed'`.** Determinista por defecto (como Claude, que directamente deshabilita `Date.now`/`Math.random`): la Capa 2 congela `Date`/`Math.random`/`crypto` en el sandbox con valores sembrados por `runId`, así el resume es 100% cache-hit barato sin pedirle nada al autor. Escape hatch `determinism:'off'` para workflows que necesiten reloj/azar real, más `ctx.unsafeNow()/ctx.unsafeRandom()` para usos puntuales. Caveat: un workflow que timestampee con la hora real verá el reloj lógico salvo que opte por `'off'`.
- **D6 — HOST eval.** El semáforo (closures/Promesas) y el journal/`occCounters` (Maps en memoria host) **no son serializables** a un Worker; anidar fragmentaría el presupuesto (`maxAgents` del padre y del hijo no se sincronizan → violación) y el cache. HOST eval con ctx-hijo (mismos semáforo/journal/agentCount/signal, sin `workflow()` → depth-1), namespace en `computeCallKey` contra falso cache-hit, y Set de nombres en curso contra ciclos. Workflows son trusted → evaluar fuera del sandbox del Worker padre es aceptable.

> **Quedan para tu visto bueno** solo si querés algo distinto: **D3** (migración global a `--mode json` ⇒ re-test de ejemplos). D5 quedó en **default `'seed'`** (determinista por defecto, opt-out `'off'`) por tu indicación. El resto se cierra por el análisis.

## 5. Riesgos técnicos

- **F (medium):** modelos débiles/salidas largas pueden no converger al JSON pese a reintentos; no hay garantía a
  nivel de decodificación (el SDK no la ofrece). Mitigable aislando el texto del asistente vía `--mode json`.
- **G:** providers sin precio dan `cost=0` aunque haya tokens reales → cortar por `spent` **persistido** (no recomputado) para no divergir en resume.
- **H:** recursión A→B→A prevenida por `depth<=1`; el error de `maxAgents` agotado debe indicar qué sub-workflow lo gatilló.
- **C/parallel:** explosión de promesas worker-side con 4096 items → tope `inFlight` default = `concurrency`.

## Archivos clave
- `extensions/dynamic-workflows.ts` (todo): interfaces l.84-245, `mapLimit` l.580, `WORKFLOW_WORKER_SOURCE` l.757,
  `allowedMethods` l.890, journal l.1248-1277, `runSubagent` l.1983, `agents`/`bash`/`sanitizeAgentOpts` l.2077-2151, finally l.2207.
- `README.md` y `skills/dynamic-workflows/SKILL.md`: documentar nuevas primitivas + matriz de paridad.
- `examples/workflows/deep-research.js`: banco de pruebas (duplicación que persona elimina; budget vía `--mode json`).

## Verificación sugerida por fase
- Reusar el harness e2e (scratchpad) que ya valida resume; extenderlo a: `agents({settle})` con un agente que
  falla (los demás siguen), `pipeline` (orden/streaming), `schema` (objeto validado + reintento), `budget` (corte).
- `tsc --noEmit` con peer deps instaladas + `esbuild --loader=ts` por fase (como en el resume).


---

## Authoring & Composición: cómo Pi decide armar y componer workflows

> Sección para anexar al plan de paridad. Integra las 4 capas (decisión, primitiva, composición, scaffolds+UX) ancladas a funciones reales de `extensions/dynamic-workflows.ts` (3202 líneas, verificado), `skills/dynamic-workflows/SKILL.md` (80 líneas) y `README.md`. **Nota de anclaje:** los números de línea de los DISEÑOS estaban desfasados; los corregidos y verificados son: `WorkflowRuntimeApi` L226-245, `WORKFLOW_TEMPLATE` L278-322, `resolveWorkflow` L451-481 (trust gate en L462/L479), `transformWorkflowCode` L726, `WORKFLOW_WORKER_SOURCE` ctx L808-827, `allowedMethods` L890-902, `makeWorkflowGraph` L1171-1217 (regex L1183, stepTypes L1172-1182), `computeCallKey` L1288, `action==="template"` L2741-2743, `action==="write"` L2802-2811, `/workflow new` L2888-2905 (parsing `commandName`/`trailingText` L2851-2852), `makeUltracodePrompt` L3019, `makeAlwaysOnUltracodeSystemPrompt` L3039-3060, `promptGuidelines` L3096-3104, `TOOL_ACTIONS` L52.

### 1. Veredicto del gap de GUÍA actual

La GUÍA de Pi existe pero es **una lista plana de disparadores de TAREA, no un marco de DECISIÓN ni de COMPOSICIÓN.** Cuatro déficits estructurales frente a la guía autoritativa de Claude:

- **Decisión (capa más alta, mayor apalancamiento).** `promptGuidelines[0-1]` (L3097-3098) y `makeAlwaysOnUltracodeSystemPrompt` (L3046-3051) enumeran casos de uso ("repo-wide audits, bug hunts, large migrations, deep research") con un OR-list que invita al **sobre-disparo**, y el único freno ("do not use for simple single-step edits") es un encuadre de costo, no un gate de trivialidad. **Faltan los tres motivos legítimos** (exhaustividad / confianza / escala), **falta scout-inline-first** (los tres ejemplos y `WORKFLOW_TEMPLATE` L296 hornean el `git ls-files` DENTRO del workflow, enseñando lo contrario: comprometerse a un workflow antes de saber si hay trabajo), y **falta scale-to-ask** (ningún dial mapea intensidad-del-pedido a número-de-agentes/profundidad-de-verificación).

- **Selección de primitiva.** Ninguna superficie enseña pipeline-vs-parallel-vs-agents. `WorkflowRuntimeApi` (L233-234) solo expone `agent`/`agents`; SKILL.md "Workflow Patterns" lista patrones de TAREA sin decir QUÉ primitiva usar. Los tres ejemplos (`repo-bug-hunt.js`, `deep-research.js`, `adversarial-plan-review.js`) usan **todos** el anti-patrón `agents()-map-barrera + synthesis`, que serializa stages innecesariamente cuando hay ≥2 stages por item. No existe `pipeline()`/`parallel()`, ni loops, ni la regla no-silent-caps (el template hace `.slice(0, 12)` y `head -200` en silencio, L296/L301).

- **Composición.** **Cero composición.** No existe `ctx.workflow()` (no está en `allowedMethods` L890-902 ni en el ctx del worker L808-827; `require`/`import` bloqueados por `transformWorkflowCode` L726). Ninguna superficie menciona sub-workflows ni secuenciar varios workflows. `normalizeWorkflowName` (L367) ya soporta subdirectorios con `/` pero nadie lo usa como namespace `lib/`.

- **Scaffolds & UX.** **Un solo scaffold** (`WORKFLOW_TEMPLATE`). `action="template"` (L2742) y `/workflow new` (L2898) **ignoran cualquier nombre** y devuelven siempre el mismo template — el README L41 (`/workflow new bug-hunt`) promete selección de patrón que el código no soporta (**doc-vs-código roto, confirmado**). No hay lint pre-run: `action="write"` (L2806) escribe crudo; el único chequeo es `transformWorkflowCode`. `makeWorkflowGraph` (L1183) es regex sobre `ctx.*` y no conoce pipeline/parallel/loop.

**Conclusión:** la GUÍA cubre el "qué tareas" pero no el "cuándo/cómo armar" ni el "cómo componer". La capa de DECISIÓN es 100% texto (cero riesgo, envío inmediato); las otras tres acoplan con primitivas del plan de paridad.

### 2. Set CONSOLIDADO de artefactos drop-in

#### 2a. `promptGuidelines` reescrito (reemplaza L3096-3104)

Sustituir el array actual por estos bullets (los dos primeros reemplazan L3097-3098; el resto se agregan):

```
promptGuidelines: [
  // DECISIÓN (reemplaza bullets 0-1)
  "Decide en tres pasos antes de orquestar. (1) Gate trivial: si la tarea es conversacional, de un solo paso, o se resuelve con unas pocas tool-calls directas, respondé normal — NO armes workflow. (2) Scout inline primero: si puede ser grande, corré una sonda barata inline (git ls-files, leer el diff, glob/grep candidatos) para descubrir la work-list real y su tamaño; solo necesitás la work-list antes del PASO de orquestación, no antes de la tarea. (3) Orquestá solo por uno de: exhaustividad (muchos items independientes a cubrir en paralelo), confianza (perspectivas independientes + verificación adversarial antes de comprometer), o escala (más contexto del que entra en una ventana: migraciones, auditorías, barridos).",
  "Escalá el esfuerzo al pedido. 'encontrá/revisá X' -> fan-out chico (~3-5 subagentes) + síntesis liviana. 'auditá a fondo/sé exhaustivo' -> pool grande + 3-5 votos adversariales por hallazgo + juez/síntesis, y loop-until-dry si el tamaño es desconocido. No pagues un patrón pesado que un pedido rápido no pidió.",
  // PRIMITIVA
  "Elegí la primitiva por dependencia de datos: ctx.agents(items,{concurrency,settle:true}) para un solo paso por item; pipeline(items,...stages) como DEFAULT cuando cada item necesita >=2 pasos encadenados y ningún paso depende de OTROS items (los items fluyen solos, sin barrera, wall-clock = la cadena del item más lento); parallel(thunks) SOLO cuando un paso posterior necesita TODOS los resultados previos a la vez (dedup/merge global, early-exit si total=0, ranking cruzado).",
  "Smell test de barrera: si un workflow hace parallel -> transform-sin-dependencia-cross-item -> parallel, sacá la barrera y escribilo como un solo pipeline; flatten/map/filter van DENTRO de una stage y nunca justifican parallel(). Para fan-out grande o paneles adversariales/jueces usá las variantes que asientan (settle:true / parallel) para que una rama caída no tumbe el batch, filtrá nulls, y ctx.log() cuántas fallaron.",
  "Para trabajo de tamaño desconocido o acotado por presupuesto usá un loop sobre una primitiva: loop-until-count (rondas fijas), loop-until-dry (parar tras K rondas sin hallazgos nuevos, dedup por clave estable), o loop-until-budget (seguir mientras ctx.budget.remaining() lo permita). Nunca acotes cobertura en silencio: cada vez que slice/head/top-N/skip-retry, ctx.log() exactamente qué dejaste afuera.",
  // COMPOSICIÓN
  "Componé workflows de dos formas: (A) ctx.workflow(name, args) corre un sub-workflow reusable inline (profundidad 1; comparte concurrency, budget de agentes, abort y cache de resume del run padre) — para sub-pasos autocontenidos sin decisión entre medio, p.ej. lib/verify-claims; (B) correr varios workflows en secuencia vía action=run/start separados (entender->diseñar->implementar->revisar), leyendo cada resultado antes del siguiente — cuando una decisión depende del output previo.",
  // SCAFFOLDS & LINT
  "Preferí un scaffold de patrón a un workflow en blanco: dynamic_workflow action=template (sin name) lista los scaffolds; action=template name=<adversarial-verify|judge-panel|loop-until-dry|multi-modal-sweep|completeness-critic|pipeline> trae uno. Elegí por objetivo: cobertura->multi-modal-sweep, confianza->adversarial-verify, best-of-N->judge-panel, descubrimiento de tamaño desconocido->loop-until-dry.",
  "action=write corre un lint pre-run. Arreglá warnings antes de correr: clampeá toda concurrency con Math.min(n, ctx.limits.concurrency), pasá concurrency a ctx.agents(), y ctx.log() cualquier cap (top-N/slice/head/sampling). Usá action=graph para previsualizar estructura y diagnósticos antes de action=run.",
  // PRESERVADOS de L3099-3104 (resume/trust/graph) — mantener tal cual
  ...
]
```

> **Mantener** los bullets existentes de resume-cache (L3101), trust/read-only (L3102) y graph (L3103) sin tocar.

#### 2b. Secciones de SKILL.md (insertar tras la línea 14, antes de "## Core Tool and Commands")

````markdown
## When to build a workflow (decision)

Work through three gates in order. Most tasks stop at the first.

1. **Trivial gate.** Conversational, single-step, or a handful of direct tool calls -> just do it. A workflow spends many model calls; don't pay that for a quick edit, lookup, or one-file change.
2. **Scout inline first.** When a task *might* be large, probe it cheaply, inline, in the current turn: `git ls-files`, read the PR diff, `grep`/glob candidates, list channels. This reveals the real work-list and its size. You don't need the shape before the *task*, only before the *orchestration step*. This hybrid (scout inline -> fan out over the discovered work-list) is the default — not building a workflow blind.
3. **Orchestrate only for a real reason.** After scouting, build a workflow only when one holds: **Exhaustiveness** (many independent items to cover in parallel), **Confidence** (high-stakes; independent perspectives + adversarial verification *before* you commit), **Scale** (more context than one window holds: repo-wide audits, large migrations, broad sweeps with artifacts/checkpoints). If none hold, stay single-agent.

### Scale effort to the ask

| Ask | Shape |
| --- | --- |
| "find some bugs", "quick read" | scout -> small fan-out (~3-5 finders) -> light synthesis |
| "review this plan", "is this safe" | a few perspective-diverse reviewers -> synthesis-as-judge |
| "audit thoroughly", "be exhaustive" | larger pool -> 3-5 adversarial votes per finding -> judge/synthesis -> loop-until-dry (stop after K quiet rounds) |

Unknown size -> prefer loop-until-dry over a fixed count; user gave a budget -> loop-until-budget.

### No silent caps

If you bound coverage (top-N, sampling, no-retry, clamping to `ctx.limits.concurrency`), `ctx.log()` what was excluded ("reviewed 40 of 213 matching files; skipped generated/ and vendored paths") so the cap is inspectable.

## Choosing a primitive (pipeline vs parallel vs agents)

Pick by data dependency, not by aesthetics.

1. **One step per item, nothing after?** `ctx.agents(items, { concurrency, settle: true })` — bounded parallel map. `settle:true` returns `null` per failed branch instead of hard-failing the batch.
2. **≥2 steps chained PER ITEM, no cross-item dependency?** `pipeline(items, ...stages)` — **THE DEFAULT for multi-stage**. Each item flows independently (A can be at stage 3 while B is at stage 1). Wall-clock = the slowest single item's chain, NOT the sum of stage durations. No global barrier.
3. **Some step needs ALL prior results at once** (global dedup/merge, early-exit on empty total, cross-item ranking)? **ONLY THEN** `parallel(thunks)` — imposes a barrier.

**Barrier smell test:** `parallel -> transform-with-no-cross-item-dependency -> parallel` => rewrite as one `pipeline`. `flatten`/`map`/`filter` belong INSIDE a stage; "conceptually separate" / "reads cleaner" do NOT justify a barrier; dedup/merge/early-exit/compare-against-others DO.

**Robustness is orthogonal:** large fan-out or adversarial/judge panels use the settling variants; filter `null`s and `ctx.log` how many failed — never hide them.

**Loops (wrap any primitive):** loop-until-count (fixed N), loop-until-dry (stop after K quiet rounds, dedup by stable key), loop-until-budget (while `ctx.budget.remaining()`).

## Composing workflows

### A. Sub-workflows: `ctx.workflow(name, args)` (depth 1)
Runs another workflow inline as a sub-step of the current run. Shares this run's concurrency pool, agent budget (`maxAgents`), abort signal, and resume journal/cache — it does NOT start a new run. Returns whatever the sub-workflow's function returns.
- Depth is 1: a sub-workflow cannot call `ctx.workflow()` again.
- Resolve by name relative to the workflow dir (`lib/...` is a subdirectory). Project and global scope both work.
- Use for reusable, self-contained steps with NO decision between them: `lib/verify-claims`, `lib/rank-candidates`, `lib/judge-panel`, `lib/completeness-critic`.

### B. Sequenced workflows (orchestrator stays in the loop)
For large work, run several workflows in sequence and read each result before the next (understand -> design -> implement -> review). Each is a separate `action=run`/`action=start`. Use when a decision depends on the previous result, or each phase deserves its own run/dashboard/budget.

**Smell test:** no decision between two sub-steps -> one run with `ctx.workflow()` (A). A "read, then decide" gate -> sequenced workflows (B).

### `lib/` convention
Single `args` object (never positional), optional `concurrency` clamped to `ctx.limits.concurrency`; validate on entry; return a stable JSON-serializable object (`{ verdict, findings, evidence, dropped }`); document the contract in a header comment.

## Pattern scaffolds

List with `dynamic_workflow action=template` (no name); fetch with `action=template name=<key>` or `/workflow new <name> --pattern=<key>`:
- `adversarial-verify` — N skeptics per finding; drop what the majority refutes (CONFIDENCE).
- `judge-panel` — N attempts from distinct angles + judges + synthesize the winner (best-of-N).
- `loop-until-dry` — repeat detect/fix until K quiet rounds or budget (unknown-size discovery).
- `multi-modal-sweep` — each agent searches a different way (grep/semantic/tests/git log) (COVERAGE).
- `completeness-critic` — a critic asks what modality/claim/source was left uncovered before synthesis.
- `pipeline` — multi-stage, each item flows independently; `parallel()` only for a real merge barrier.

Every scaffold clamps concurrency, keeps audit subagents read-only, and `ctx.log()`s any cap. `action=write`/`/workflow new` run a pre-run lint: errors block, warnings inform.
````

> **Política de fuente única:** SKILL.md es la forma canónica larga; `promptGuidelines` y el system-prompt son proyecciones comprimidas. `scaffoldIndex()` (ver 3) se genera del catálogo en runtime, así el índice nunca miente aunque la prosa quede atrás.

#### 2c. Bloque del system-prompt del router (reemplaza el cuerpo de `makeAlwaysOnUltracodeSystemPrompt`, L3040-3059)

```
## Always-on Ultracode Workflow Router

For every substantive task, silently run this decision before choosing an approach. Do not narrate it for trivial tasks.

1. Trivial gate. Conversational, single-step, or a few direct tool calls -> solve normally, single-agent. Do not build a workflow.
2. Scout inline first. If the task might be large, probe it cheaply this turn (git ls-files, read the diff, grep/glob candidates) to learn the real work-list and its size. You need the work-list before the orchestration step, not before the task.
3. Orchestrate only for a reason. After scouting, prefer dynamic_workflow only when one holds: exhaustiveness (many independent items in parallel), confidence (independent perspectives + adversarial verification before committing), or scale (more context than one window holds: migrations, audits, broad sweeps, long-running work with checkpoints). Else stay single-agent.
4. Scale to the ask. Light ("find some","quick check") -> small fan-out (~3-5) + light synthesis. Heavy ("audit thoroughly","be exhaustive") -> larger pool + 3-5 adversarial votes per finding + judge/synthesis, loop-until-dry when size is unknown.

When a workflow is warranted: scout inline, then pipeline() over the discovered work-list by default; ctx.agents(items,{concurrency,settle:true}) for a single step per item; reserve parallel(thunks) for true barriers (global dedup/merge, early-exit when total is zero). Compose with ctx.workflow(name,args) for reusable sub-steps (depth 1, shares budget/abort/cache); for phased work with a decision between phases, run separate workflows in sequence (action=run/start) and read each result. Keep fan-out bounded by ctx.limits.concurrency, use read-only tools for audit/research subagents, persist state with ctx.writeArtifact(), and ctx.log() any coverage cap instead of capping silently.

Mention the routing decision only when it affects the plan, cost, latency, or user expectations.
```

> El último párrafo nombra `pipeline()`/`parallel()`/`ctx.workflow()`/`ctx.budget`. **Gatear ese párrafo** detrás del shipping de esas primitivas (ver §4); si no llegan, degradar a wording con `ctx.agents()` y omitir composición.

#### 2d. Librería de scaffolds por patrón (`WORKFLOW_SCAFFOLDS`, nuevo, junto a `WORKFLOW_TEMPLATE` L322)

`Record<string,{title,blurb,code}>` con claves `default` (alias del actual `WORKFLOW_TEMPLATE`), `adversarial-verify`, `judge-panel`, `loop-until-dry`, `multi-modal-sweep`, `completeness-critic`, `pipeline`. Cada `code` es `SCAFFOLD_HEADER(when, smell) + <PATTERN>_BODY` (consts `String.raw`). Patrón de cuerpo, idéntico para todos (clamped concurrency + read-only tools + evidence contract + `ctx.log` de cap + **fallback `ctx.agents` vivo, primitiva nueva comentada**):

```js
// loop-until-dry (ejemplo de cuerpo; el resto siguen la misma forma)
module.exports = async function workflow(ctx, input) {
  const concurrency = Math.min(input?.concurrency ?? ctx.limits.concurrency, ctx.limits.concurrency);
  const quietToStop = input?.quietRounds ?? 2, maxRounds = input?.maxRounds ?? 6;
  let quiet = 0, round = 0; const seen = new Set(), all = [];
  while (quiet < quietToStop && round < maxRounds) {
    round++;
    const res = await ctx.agent(
      "Find NEW issues not in this list (dedupe by id). JSON array {id,claim,evidence}; [] if none.\nSeen: " + JSON.stringify([...seen]),
      { name: "sweep-" + round, tools: ["read","grep","find","ls"], cache: false });
    let batch = []; try { batch = JSON.parse(res.output); } catch {}
    const fresh = batch.filter((b) => b && !seen.has(b.id));
    fresh.forEach((b) => { seen.add(b.id); all.push(b); });
    await ctx.log("round complete", { round, fresh: fresh.length, quiet });
    quiet = fresh.length === 0 ? quiet + 1 : 0;
  }
  if (round >= maxRounds && quiet < quietToStop) await ctx.log("stopped at budget, not dry (no silent caps)", { maxRounds });
  await ctx.writeArtifact("findings.json", all);
  return (await ctx.agent("Synthesis-as-judge over all rounds. Dedupe, prioritize, keep evidence.\n\n" + ctx.compact(all, 60000),
    { name: "synthesis", tools: ["read","grep","find","ls"] })).output;
};
```

Más un scaffold `lib/verify-claims` (sub-workflow reusable, contrato `{ claims, concurrency? } -> { findings, dropped }`) y un `pipeline-driver` (scout inline -> fan-out -> `ctx.workflow("lib/verify-claims", ...)` -> síntesis) como ejemplos de Plano A. Texto/código completo en los DISEÑOS 3 y 4.

### 3. Cambios de CÓDIGO requeridos

| # | Cambio | Anclaje (verificado) | Capa | Dep. paridad |
|---|--------|----------------------|------|--------------|
| C1 | **Reescribir `makeAlwaysOnUltracodeSystemPrompt`** (cuerpo del string) + reescribir `promptGuidelines[]` + insertar secciones en SKILL.md | L3040-3059; L3096-3104; SKILL.md L14 | DECISIÓN | **Ninguna** (envío inmediato; último párrafo del prompt gatea primitivas) |
| C2 | **`pipeline(items,...stages)` y `parallel(thunks)` worker-side**: agregar al ctx del worker (L808-827). Son thunks/funciones puras worker-side -> **NO entran en `allowedMethods`** (no cruzan el bridge). `agents({settle})` SÍ pasa por hostCall -> solo extiende `opts` en `agents` (L816 + host L2342+) | L808-827; L890-902 | PRIMITIVA | **Prereq.** plan de paridad gaps A y C |
| C3 | **`ctx.budget.remaining()/spent()`** para loop-until-budget | ctx worker L808-827 | PRIMITIVA | **Prereq.** paridad gap G (P2.1) |
| C4 | **`ctx.workflow(name,args,opts)`**: agregar a `WorkflowRuntimeApi` (L226-245), al ctx worker (L815 zone) como `hostCall("workflow",...)`, **agregar `"workflow"` a `allowedMethods`** (L890-902), e implementar el host: `resolveWorkflow` -> `readFile` -> `transformWorkflowCode` -> **evaluar en el HOST (no re-anidar Worker)** -> invocar con ctx-HIJO que reusa el MISMO `agentSemaphore`/`agentCount`/`runSignal`/`runDir`/`journal`. Enforce **depth-1** (ctx-hijo expone `workflow()` que lanza) + Set de nombres en curso (ciclos). Emitir `appendEvent({type:"workflow",name,phase})` (L2181). Respetar trust de `resolveWorkflow` (L462/L479) al componer | L226-245; L890-902; L2181; L2342 | COMPOSICIÓN | independiente del resto |
| C5 | **`WORKFLOW_SCAFFOLDS` + bodies** (consts `String.raw`) + `scaffoldIndex()` | junto a L322 | SCAFFOLDS | usa C2/C4 con fallback comentado |
| C6 | **Reescribir `action==="template"`** (L2741-2743): `name=<patrón>` devuelve el scaffold; `name` vacío devuelve `scaffoldIndex()` + `details.patterns` | L2741-2743 | SCAFFOLDS | C5 |
| C7 | **Reescribir `/workflow new`** (L2888-2905): usar `commandName` como nombre Y `--pattern=` (de `trailingText` L2852) para precargar scaffold; sin flag y con UI -> **fallback a `ctx.ui.editor` sembrado con el índice como comentario** (⚠ `ctx.ui.select` **NO existe**; solo `editor`/`confirm`/`custom`/`notify` — verificado L2032/L2059/L2113). Cierra el roto del README L41 | L2888-2905; L2851-2852 | SCAFFOLDS/UX | C5 |
| C8 | **`lintWorkflowCode` + `formatDiagnostics`** (heurística regex, sin deps) e integrar: `action="write"` (L2806) bloquea errores / muestra warnings; `action="run/start"` log no-bloqueante al journal; nuevo `/workflow lint <name>`. Agregar `"lint"` al usage (L3113) y opcional a `TOOL_ACTIONS` (L52) | L52; L2806; L3113 | SCAFFOLDS/UX | independiente |
| C9 | **Ampliar `makeWorkflowGraph`** (L1171-1217): regex (L1183) + `pipeline\|parallel\|loop`; `parallel` = subgraph con barra de sync, `pipeline` = lanes independientes; **`workflow`** -> subgraph anidado (usa `extractFirstStringLiteral` para el name); footer "No visualiza: concurrency real, branches, error paths, budget" + incrustar diagnósticos del lint | L1171-1217 | TODAS (preview) | C4/C8 |
| C10 | **`computeCallKey` namespace** (L1288): prefijar la key con nombre del sub-workflow para evitar falso cache-hit padre/hijo al compartir journal | L1288 | COMPOSICIÓN | C4 |

Plano B de composición (secuenciar varios `action=run/start`) **no necesita código** — ya funciona con `run`/`start`/`view` (`TOOL_ACTIONS` L52).

### 4. Encaje con prioridades P0/P1/P2 del plan de paridad

| Capa de guía | Drop-in / código | Depende de primitiva | Prioridad sugerida |
|--------------|------------------|----------------------|--------------------|
| **DECISIÓN** (3-gate + scout + scale + no-silent-caps) | C1 (texto puro) | **Ninguna** (salvo el último párrafo del prompt) | **P0** — envío inmediato, cero riesgo de código; corrige sobre/sub-disparo, la falla más cara |
| **PRIMITIVA** (pipeline-default + smell test + settle + loops) | C2/C3 + bullets/SKILL/scaffold-comments | `pipeline`/`parallel`/`agents{settle}` (paridad **gaps A,C** → P0.2/P1.2), `ctx.budget` (gap G → **P2.1**) | **P1** — guía P1; recetas budget detrás de P2.1 |
| **COMPOSICIÓN Plano B** (secuenciar) | texto (SKILL/prompt/README) | **Ninguna** | **P1** — guía sin código |
| **COMPOSICIÓN Plano A** (`ctx.workflow`) | C4 + C10 | nueva primitiva host (independiente) | **P1/P2** — el grueso del esfuerzo de composición |
| **SCAFFOLDS & UX** (catálogo, template-index, /workflow new, lint, graph) | C5-C9 | scaffolds `pipeline`/`adversarial-verify` usan C2/C4 (**fallback `ctx.agents` vivo** los hace correr hoy) | **P1/P2** — aditivo; `default`/`loop-until-dry`/`multi-modal`/`completeness-critic`/lint no dependen de primitivas nuevas y van antes |

**Dependencias guía→primitiva (qué guía espera a qué):** la guía de pipeline/parallel/settle (bullets de primitiva, scaffold `pipeline`) **espera paridad gaps A y C**; la receta loop-until-budget y los scaffolds que la usan **esperan paridad gap G (P2.1)**; toda la guía de composición Plano A **espera C4** (no está en paridad — es trabajo nuevo de esta capa). La guía de DECISIÓN, scale-to-ask, no-silent-caps, composición Plano B, y los scaffolds `default`/`loop-until-dry`/`multi-modal-sweep`/`completeness-critic` + el lint **no esperan nada** y pueden ir en P0/P1 ya.

### 5. Riesgos

1. **Guía que promete primitivas aún no implementadas (riesgo central).** El system-prompt, bullets y scaffolds nombran `pipeline()`/`parallel()`/`agents({settle})`/`ctx.budget`/`ctx.workflow()`, ninguna existente hoy (ctx worker L808-827, allowedMethods L890-902). Publicar la guía antes que el código enseña una API inexistente. **Mitigación:** gatear los drop-ins detrás de las fases P0.2/P1.2/P2.1; en scaffolds dejar el **fallback `ctx.agents` como código vivo** y la primitiva como comentario; etiquetar loop-until-budget como "cuando esté disponible".
2. **`ctx.ui.select` no existe (confirmado).** El DISEÑO 4 lo asume; el código solo tiene `editor`/`confirm`/`custom`/`notify` (L2032/L2059/L2113). **Mitigación obligatoria:** C7 usa `ctx.ui.editor` sembrado con el índice como comentario, o `ctx.ui.custom`; no introducir `select`.
3. **Re-entrada en VM al componer.** Evaluar el sub-workflow dentro del Worker del padre choca con el sandbox VM actual (L856). **Mitigación (recomendada):** el host `workflow()` resuelve+evalúa en el **HOST** e invoca pasando el mismo api — más simple y seguro que re-anidar VMs/Workers.
4. **Budget/cache compartidos sin transparencia.** El sub-workflow consume `maxAgents` del padre (puede dejarlo sin presupuesto: "exceeded maxAgents") y comparte `journal`/`occCounters` → falso cache-hit entre padre e hijo. **Mitigación:** `ctx.log` al entrar/salir del sub-workflow con agentCount restante (no-silent-caps) + namespace en `computeCallKey` (C10).
5. **Profundidad/ciclos.** Sin enforcement, A→B→A cuelga o explota budget. Depth-1 + Set de nombres en curso es **obligatorio** (C4).
6. **Lint heurístico (regex) con falsos positivos/negativos.** Un `.slice()` legítimo no relacionado a cobertura dispara `silent-cap`. **Mitigación:** solo `level=error` bloquea (hoy ninguna regla emite error salvo decisión explícita); warnings informan; reglas conservadoras; lint bloqueante en `write` podría romper flujos que escriben código "sucio" intencionalmente → solo errores bloquean.
7. **Bloat de prompt.** `makeAlwaysOnUltracodeSystemPrompt` se inyecta en cada `before_agent_start` (L3187); la reescritura es más larga que las ~18 líneas actuales. **Mitigación:** la estructura numerada es más densa que la prosa que reemplaza; mantenerla en los 5 párrafos cortos mostrados.
8. **Deriva entre 4 superficies + README.** Agregar un scaffold sin actualizar prosa reintroduce el roto que hoy tiene README L41. **Mitigación:** SKILL.md como forma canónica; `promptGuidelines`/system-prompt como proyecciones; `scaffoldIndex()` generado del catálogo en runtime para que el índice nunca mienta.
9. **Confusión Plano A vs B.** Sin smell test claro, el modelo usa `ctx.workflow()` para fases con decisión humana (debería ser B) o lanza N runs para sub-pasos sin decisión (debería ser A). **Mitigación:** smell test explícito en SKILL.md y system-prompt.
10. **Trust al componer.** `resolveWorkflow` exige proyecto trusted para scope project (L462/L479); un sub-workflow global llamado desde uno project debe respetar el mismo gate — no relajar trust al componer (C4).

### Critical Files for Implementation
- /Users/andrestobelem/ws/at/pi-dynamic-workflows/extensions/dynamic-workflows.ts
- /Users/andrestobelem/ws/at/pi-dynamic-workflows/skills/dynamic-workflows/SKILL.md
- /Users/andrestobelem/ws/at/pi-dynamic-workflows/README.md
- /Users/andrestobelem/ws/at/pi-dynamic-workflows/examples/workflows/repo-bug-hunt.js
- /Users/andrestobelem/ws/at/pi-dynamic-workflows/examples/workflows/adversarial-plan-review.js