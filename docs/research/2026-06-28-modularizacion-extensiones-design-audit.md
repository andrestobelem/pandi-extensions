---
type: "Research Review"
title: "Modularización de extensiones — Design Audit y roadmap"
description: "Auditoría de diseño y roadmap para modularizar extensiones Pi."
tags: [architecture, refactoring, extensions, design-audit]
timestamp: 2026-06-28T00:00:00Z
---

# Modularización de extensiones — Design Audit y roadmap

Fecha: 2026-06-28

## Objetivo

Auditar el diseño del monorepo de 9 extensiones Pi y producir un plan incremental,
**behavior-preserving**, para: (1) modularizar el código, (2) sacar duplicación a módulos
compartidos, (3) modularizar los tests, (4) revisar el diseño con lente Kent Beck / Dave
Farley, y (5) aplicar los mismos conceptos (DRY / single-source) a los prompts.

## En 30 segundos

Este informe resume una auditoría de diseño del monorepo de 9 extensiones Pi y propone una ruta
incremental para modularizar sin cambiar el comportamiento observable. Sirve para decidir qué
extraer primero, qué dejar como está y dónde está el riesgo real: estado mutable compartido,
bootstrap de tests duplicado y prompts que conviene tratar como fuente única de verdad.
Si vas a tocar una extensión grande o a mover código compartido, empezá por acá.

## Procedencia

- **Contract Gate** (4 reviewers read-only + síntesis): contrato de tarea, sin blockers.

- **Design Audit** (9 analizadores por extensión + 4 transversales + síntesis-as-judge),
  ejecutado como dynamic workflow read-only.

  Artefactos del run:
  - `.pi/workflows/drafts/modularizar-extensiones-design-audit.js` →
  - `.pi/workflows/runs/2026-06-28T06-02-42-987Z-drafts-modularizar-extensiones-design-audit-a6e2980c/`
  - `design-audit.md`, `roadmap.json`, `scout-evidence.md`, `analyzer-*.json`

- **Limitación conocida:**
  - 1 de 9 analizadores por extensión (`pandi-goal`) falló validación de schema; la síntesis usó 8 ext + 4 transversales.
  - La salida de síntesis se truncó al final de §7 (la fila 3.17 quedó cortada).
  - El roadmap máquina-legible completo está en `roadmap.json`.
  - Las secciones §8/§9 se restauran abajo desde el plan de verificación del contrato.

## Estado de implementación (sesión 2026-06-28)

Rondas ejecutadas con las siguientes garantías:
- Conventional Commit atómico por ronda
- `npm test` verde 23/23 + typecheck validado
- Move-only / behavior-preserving (sin cambios de comportamiento)
- Baseline previo verde registrado

| Ronda | Commit | Qué | Verificación |
|---|---|---|---|
| 2.1 | `refactor(shared): extract formatEta` | `formatEta` byte-idéntico (loop+goal) → `extensions/shared/time.ts` | npm test 23/23 |
| 2.4 | `refactor(shared): extract notify` | `notify` byte-idéntico (plan/loop/goal/dynamic-workflows, mismo md5) → `extensions/shared/notify.ts` (NotifyContext estructural) | npm test 23/23 |
| 3.1 | `refactor(effort): parse.ts` | parsing puro (THINKING_LEVELS/EffortTarget/LEVEL_ALIASES/parseEffortTarget) → `pi-effort/parse.ts` | npm test 23/23 |
| 3.5 | `refactor(plan): gate.ts` | gate read-only puro (MUTATING_BASH_PATTERNS/isMutatingBash/blockedReason) → `pi-plan/gate.ts` (diff: byte-idéntico + export) | npm test 23/23 (incl. plan-gate 45 asserts) |

**Validado empíricamente:** el seam `extensions/shared/*.ts` importado vía `../shared/x.js` se empaqueta (files glob), se typechequea transitivamente (tsc sigue imports), y se bundlea en los tests (esbuild reescribe `.js`→`.ts`).

*Lección Karpathy:* un glob `*/` dentro de un comentario JSDoc cierra el bloque — inspecciona el dato (corregido en `time.ts`).

**Decisión de diseño (skip consciente):** Ronda 2.2 `projectHash` se OMITIÓ.
- No es una función compartida limpia sino una expresión inline: `crypto.createHash("sha1")...slice(0,12)`
- Consolidarla en loop/goal fuerza shadowing de nombres por ~1 línea de ahorro.
- Principio: "Make complexity earn its place" — el costo supera el payoff.

> **Artefacto de DESIGN-AUDIT (synthesis-as-judge)**
>
> - **Fuente de verdad:** únicamente los analizadores verificados (8 por extensión + 4 transversales).
> - **Cobertura:** `ext=8 válidos`, `cross=4 válidos`, `1 analizador por extensión fallido` (ver §9).
> - **Citas:** toda afirmación de hecho lleva cita `file:line`; lo que no la tiene se marca como inferencia o se omite.
> - **Restricción rectora:** refactor incremental, **sin cambio de comportamiento observable**, módulos a **profundidad uno**, `index.ts` como agregador delgado, `npm test` verde antes/después de cada commit, Conventional Commits atómicos, Kent Beck tidy-first (todo aquí es estructural), Dave Farley (cohesión + fast feedback), sin big-bang.

---

## 1. Veredicto ejecutivo

### Estado general de salud

El conjunto es sano en su mayoría:
- **Pequeñas y cohesivas (6 extensiones):** `pandi-local-memory` 31 LOC, `pandi-auto-compact` 120, `pandi-mdview` 181, `pandi-effort` 247, `pandi-bg` 637, `pandi-plan` 656
- **Monolitos genuinos (2 extensiones):** `pandi-dynamic-workflows` 7143 LOC, `pandi-loop` 1599 LOC (~13–16 concerns cada uno)

### Oportunidades de DRY transversal

Estrecha y de alta calidad:
- `notify()` — 4 copias byte-idénticas + 2 variantes endurecidas
- `formatEta()` — 2 copias byte-idénticas
- Trío `projectHash`/`writeSidecar` atómico/`dual-root state dir` — variantes near-identical

Justifican un módulo compartido. El resto que "parece" duplicado (cuerpos de `persist`/`rehydrate`/`formatStatus`, esquemas TypeBox, prompts de Ultracode) son **shapes y paráfrasis deliberadas, no código compartible**. Fusionarlos acoplaría máquinas de estado divergentes con riesgo High.

### Duplicación de prompts

Hay **un único** duplicado byte-a-byte real: el bloque "Research-backed templates" en 4 sitios. Lo demás ya está centralizado en funciones `format*` de `templates.ts`, que es el patrón positivo a replicar.

### Deuda técnica en tests

La más cara y mejor aislada vive en los tests: el bootstrap esbuild se reimplementa ~24 veces (~1000–1400 LOC) con flags y stubs divergentes, lo que también infla las suites grandes (>500 LOC).

### Estrategia recomendada

Mejor ratio valor/riesgo:
1. Empezar por guardianes de prompts (Fase 1, Low, cero cambio de wording)
2. Extracciones puras compartidas (`formatEta`, `projectHash`)
3. Validar el patrón de descomposición en extensiones pequeñas antes de tocar los monolitos
4. Dejar `runtime.ts`/`worker-source` de `pandi-dynamic-workflows` y el `state.ts` compartido de `pandi-loop` para el final, tras tests de caracterización

### Riesgo dominante

No es la mecánica de mover archivos sino el **estado mutable compartido:**
- `activeRuns`/`appendFileMutexes` (dynamic-workflows)
- `activeLoops`/`wakeQueue`/`autopilotTurnInFlight` (loop)
- `activePlans`/`PLAN_MODE_GUARD` (plan)
- `activeJobs` (bg)

También contratos cross-extension por `Symbol.for`/evento.

---

## 2. Mapa de duplicación (cross-extension)

| Cluster | Qué | Copias (file:line) | Idéntico / Variante | Módulo compartido propuesto | Consumidores | Riesgo | Payoff (LOC) |
|---|---|---|---|---|---|---|---|
| C1 notify | Helper de notificación UI/print | `pi-plan/index.ts:209`, `pi-loop/index.ts:430`, `pi-goal/index.ts:533`, `pi-dynamic-workflows/index.ts:1715` (idénticas); `pi-effort/index.ts:81`, `pi-mdview/index.ts:11` (endurecidas stderr) | 4 byte-idénticas + 2 variantes (effort/mdview enrutan error→stderr; mdview usa `ExtensionCommandContext`) | `extensions/shared/notify.ts` con flag `{stderrOnError?}` por defecto preservando comportamiento; `ctx` tipado estructural `{mode;hasUI;ui?}` | plan, loop, goal, dynamic-workflows (+ effort/mdview como variante) | Low (4 idénticas) / Medium (si se pliegan effort+mdview por el tipo de ctx y stderr) | ~30 |
| C2 formatEta | Formateo de tiempo relativo | `pi-loop/index.ts:298`, `pi-goal/index.ts:429` | 2 byte-idénticas | `extensions/shared/time.ts` (`formatEta`; `formatInterval` solo si se confirma idéntico) | loop, goal | Low (pura, sin ctx) | ~10 |
| C3 state-store | Write atómico sidecar + dual-root dir + `projectHash` + JSONL append | `writeSidecar` `pi-loop:393` vs `pi-goal:519`; dir `pi-loop:386` vs `pi-goal:512`; `projectHash` `pi-loop:388,1054`, `pi-goal:514`, `pi-dynamic-workflows:975`, `pi-bg:81`; append `pi-bg:185` vs `pi-dynamic-workflows:5633→407` | Near-identical (difieren tipo de estado y `LOOP_DIR/GOAL_DIR`); `projectHash` idéntico; `appendEvent` **divergente** | `extensions/shared/state-store.ts` (`projectHash`, `stateDir`, `writeSidecarAtomic<T>`) + `extensions/shared/jsonl.ts` (`appendJsonLine` con mutex como canónico) | loop, goal, dynamic-workflows, bg | Low (`projectHash`/write atómico) / Medium (plegar `bg.appendEvent` que **traga errores y NO usa mutex** → cambio de concurrencia) | ~60–80 |
| C4 persist/rehydrate/formatStatus | "Shape" de stateful command extension | persist `pi-plan:204`, `pi-loop:371`, `pi-goal:500`; rehydrate `pi-plan:464`, `pi-loop:950`, `pi-goal:872`; formatStatus `pi-plan:488`, `pi-loop:1150`, `pi-goal:940` | **Variantes, NO duplicados** (plan sin sidecar; loop merge por `updatedAt` + gate autónomo; goal backfills P1; tres `formatStatus` distintos) | **NO extraer cuerpos.** Solo el kernel puro `collectLatestByKey<T>(entries,type,keyOf)` en `extensions/shared/session-state.ts` | plan, loop, goal | High si se fusionan cuerpos / Low si solo el colector | ~15–25 (solo colector) |
| C5 TypeBox builders | Esquemas de parámetros de tool | `pi-plan:534`, `pi-goal:1012`, `pi-loop:1413,1480`, `pi-dynamic-workflows:450` | Idioma compartido, contenido domain-specific distinto | **No extraer** (false-DRY; acoplaría contratos no relacionados) | plan, goal, loop, dynamic-workflows | Low (no-acción) | ~0 |

Notas duras del transversal de packaging: `extensions/shared/*.ts` SÍ casa con el glob `files: extensions/*/*.ts` y se empaqueta; NodeNext exige specifiers `.js` (p.ej. `../shared/notify.js`). **Antes de fusionar cualquier par, diff a nivel de cuerpo**: el analizador de packaging advierte explícitamente que los nombres iguales (notify×7, walk×3, etc.) pueden tener cuerpos divergentes; toda consolidación es condicional a que un diff pruebe equivalencia.

---

## 3. Límites de módulos por extensión

### pi-dynamic-workflows (7143 LOC) — monolito, descomponer último y con tests

| Módulo | Responsabilidad | movesFrom | approxLoc |
|---|---|---|---|
| `util.ts` | mutex/json/signals/mapLimit/semaphore/path/`runProcess` | `index.ts:360-520,1145-1365,2659-2753` | 450 |
| `workflow-files.ts` | discovery, name/scope/path resolution, trust gating | `index.ts:921-1090` | 200 |
| `ultracode.ts` | routing/contract-gate/always-on prompts, task extraction | `index.ts:6835-6965` | 140 |
| `status-format.ts` | formatters status/widget/run/agent (presentación) | `index.ts:1692-1942,3394-3644` | 450 |
| `worker-source.ts` | blob `WORKFLOW_WORKER_SOURCE` + `transformWorkflowCode` | `index.ts:1370-1583` | 215 |
| `agents.ts` | personas, access resolution, schema validation/retry | `index.ts:170-222,586-920` | 420 |
| `graph.ts` | modelo de grafo + render text/mermaid/image | `index.ts:1943-2895` | 950 |
| `runs.ts` | journal/run IO, events.jsonl, monitor model | `index.ts:2896-3650` | 750 |
| `lifecycle.ts` | prepare/start-bg/resume/cancel/delete, active-run registry | `index.ts:1300-1360,6170-6456` | 360 |
| `dashboard.ts` | TUI `WorkflowDashboard`, down-editor, live view | `index.ts:3653-3760,4016-5580` | 1500 |
| `runtime.ts` | engine: ctx API, subagent/bash, journal cache, semáforo, artifacts, worker | `index.ts:1584-1691,5580-6170` | 700 |

Queda en `index.ts`: registro del tool `dynamic_workflow`, comandos `/workflow`,`/workflows`,`/ultracode`,`/deep-research`,`/ultracode-contract`,`/ultracode-mode`, atajo `ctrl-alt-w`, hooks `input/before_agent_start/session_start/session_shutdown`, evento `ULTRACODE_MODE_EVENT`, y claves de status/widget (`index.ts:6971-7143`). **Más riesgosos (al final, con caracterización):** `runtime.ts` (singletons `activeRuns`/`appendFileMutexes` y la invariante de occurrence-cache) y `worker-source.ts` (debe quedar byte-compatible).

### pi-loop (1599 LOC) — monolito, descomponer tras pi-plan/pi-bg

| Módulo | Responsabilidad | movesFrom | approxLoc |
|---|---|---|---|
| `state.ts` | tipos+constantes + globals mutables (`activeLoops`,`wakeQueue`,`autopilotTurnInFlight`) + `resetState()` | `index.ts:89-205` | 120 |
| `prompt.ts` | `makeLoopIterationPrompt` (puro) | `index.ts:207-266` | 60 |
| `interval.ts` | parse/clamp/format intervalos+ETA + `splitTaskAndInterval` | `index.ts:269-301` | 40 |
| `status.ts` | render status-line + `formatStatus` | `index.ts:305-343,1150-1157` | 60 |
| `persistence.ts` | snapshot + JSONL + sidecar atómico dual-root + `newerState` + notify | `index.ts:345-437,935-948,1052-1056` | 160 |
| `guard.ts` | gate destructivo (regex allowlist, redirect/tee, path-escape) | `index.ts:1262-1396` | 150 |
| `commands.ts` | routing `/loop` subcomandos | `index.ts:1159-1223` | 70 |
| `scheduler.ts` | wake/drain/FIFO/fire/rearm + cap gating | `index.ts:448-652` | 230 |
| `lifecycle.ts` | start/auto-start/resolve/stop/pause/resume + `makeActiveLoop` | `index.ts:654-933` | 250 |
| `recovery.ts` | rehydrate + GC terminal + watchdog | `index.ts:950-1148` | 190 |

Queda en `index.ts` (~210): tools `loop_schedule`/`loop_stop` + promptGuidelines, comando `/loop` + completions, handlers `tool_call/session_start/session_shutdown/agent_end`. **Invariante crítica:** todos importan **un solo** `state.ts`; `autopilotTurnInFlight` debe ser una celda compartida (no copiada) o se rompen serialización/seguridad.

### pi-plan (656 LOC) — descomposición opcional, value-driven

| Módulo | Responsabilidad | movesFrom | approxLoc |
|---|---|---|---|
| `gate.ts` | política read-only pura (`MUTATING_BASH_PATTERNS`,`isMutatingBash`,allowlist,`blockedReason`) | `index.ts:259-386` | 130 |
| `prompts.ts` | `makePlanningPrompt`/`makeImplementPrompt` + reglas read-only canónicas | `index.ts:133-165` | 40 |
| `state.ts` | tipos + `activePlans` + `PLAN_MODE_GUARD` chain + persist + rehydrate | `index.ts:61-130,204-207,464-486` | 140 |
| `ui.ts` | status-line + notify + formatStatus | `index.ts:171-200,209-222,488-492` | 60 |

Queda en `index.ts`: única `piExtension`, comando `/plan`, tool `submit_plan`, eventos, y **re-export** de `isPlanModeActive`/`PLAN_MODE_GUARD`/`PLAN_MODE_GUARD_SYMBOL` (`index.ts:88-122`) que otras extensiones consumen vía `globalThis`. Mejor ganancia: `gate.ts` + `prompts.ts`.

### pi-bg (637 LOC) — cohesiva; preferir solo `storage.ts` primero

| Módulo | Responsabilidad | movesFrom | approxLoc |
|---|---|---|---|
| `storage.ts` | layout de rutas + safety fs + bounded read + write atómico + append | `index.ts:90-208,427-460` | 130 |
| `runner.ts` | spawn, backpressure, finalize/kill, `activeJobs` registry | `index.ts:76,233-393,476-510` | 180 |
| `jobs.ts` | id/validación, discovery, `deriveState`/`decorateStatus` | `index.ts:79-111,155-230` | 90 |
| `commands.ts` | subcomandos + dispatch + gating plan/mode/trust + format | `index.ts:236-589` | 230 |

Queda en `index.ts`: comando `/bg`, completions, wiring; **re-exportar** helpers que los tests importan (`atomicWriteJson`,`guardStreamErrors`,`isJobFinished`,`pipeWithBackpressure`,`finalizeJob`,`safeFinalize`). Riesgo: `Symbol.for` plan-mode guard y `activeJobs`.

### Extensiones "verificar, no forzar"

#### pi-effort (247 LOC)
- Módulo único justificado: `parse.ts` (`index.ts:24-57,99-117`, ~55 LOC)
- El resto queda en `index.ts`
- No relocalizar `ULTRACODE_MODE_EVENT`/`dynamic_workflow` (`index.ts:16,203`)

#### pi-auto-compact (120 LOC)
- Módulo opcional: `threshold.ts` (`index.ts:3-11`, ~12 LOC)
- **Re-exportar:** `parseThreshold`/`DEFAULT_THRESHOLD_PERCENT`
- Mayor valor: extraer decisión pura `decideCompaction` para tests rápidos, sin file-split obligatorio

#### pi-mdview (181 LOC)
- Módulos opcionales: `path-resolve.ts` (`index.ts:23-40`, ~20 LOC) y `viewer-component.ts` (`index.ts:42-148`, ~110 LOC)
- Value-neutral en runtime; solo si se añaden tests de caracterización primero

#### pi-local-memory (31 LOC)
- **NO modularizar**
- Cohesivo: un hook `before_agent_start`
- Mejora opcional: consolidar el `TAG` y añadir 2 tests de escaping (mayúsculas/open-tag)

---

## 4. Plan single-source-of-truth de prompts

| Prompt / instrucción | Ubicación canónica propuesta | Copias a reconciliar | Cómo verificar igualdad |
|---|---|---|---|
| Bloque "Research-backed templates" | `templates.ts:1229` (`formatWorkflowPatternCatalog`, derivado de `WORKFLOW_PATTERN_CATALOG`) — **única byte-idéntica real** | `.pi/skills/dynamic-workflows/SKILL.md:65-77`, `README.md:119-131` (raíz), `extensions/pandi-dynamic-workflows/README.md:323-335` | Test de integración que extrae la sección entre `Research-backed templates` y la línea de cierre, canonicaliza (trim por línea, normalizar prefijo `##`/`###`, join `\n`) y compara byte-a-byte contra la subcadena de `formatWorkflowPatternCatalog()` |
| Claves de catálogo / resumen de composición | `templates.ts:1295,1300,1275,1285` (ya SSOT) | — (no hay copias divergentes) | Test que verifica que `makeUltracodePrompt`/`makeAlwaysOnUltracodeSystemPrompt` contienen exactamente `formatWorkflowPatternKeyList()` |
| Reglas Ultracode / Contract Gate | **NO unificar.** Runtime SSOT: `index.ts:6835` (`formatUltracodeContractGatePrompt`) + `index.ts:6845` (`formatUltracodeRoutingRules`); SKILL/README son derivados conceptuales | `index.ts:6989-7012` promptGuidelines, `SKILL.md:18-21,128-163`, `README.md:84-99` | Documentar capa canónica; **único** acoplamiento blindable = claves del catálogo (test de §4 fila 2). Fusionar wording = riesgo High (rompe `ultracode-contract-gate.test.mjs`, `model-thinking-selection.test.mjs`) |
| Personas system prompts | `index.ts:179-199` (ya SSOT, sin copias en docs) | — (grep confirma solo en `index.ts`) | Test ligero opcional que verifica que `makeAgentOptions` usa la constante (`index.ts:178`) |
| promptGuidelines loop/goal/plan | SSOT local por extensión (`pi-goal:1002`, `pi-loop:1405`, `pi-plan:529`) | READMEs parafrasean en prosa (no copias) | **No DRY cruzado**: packaging (profundidad uno, sin carpeta común en `files` para README) lo desaconseja |

Regla general: el único trabajo de prompts en Fase 1 es **añadir guardianes** (no reescribir wording). Solo si más adelante se quiere reducir LOC, generar las secciones markdown desde `formatWorkflowPatternCatalog()` en un paso de build, dejando los `.md` como artefactos derivados.

---

## 5. Plan de modularización de tests

**Estado verificado:** **no existe** harness compartido; cada una de las 24 suites reimplementa el bootstrap esbuild→tempdir→`pathToFileURL` con variantes incompatibles:
- `npx --no-install esbuild`: auto-compact.test.mjs:39, local-memory.test.mjs:39
- `npx esbuild` plano: effort, mdview, bg, plan
- `npx --yes esbuild` con 2 alias: goal-verifier.test.mjs:94-100
- `npx --yes esbuild` con 5 alias: composition-rank.test.mjs:79-87

**Harness/fixtures compartidos** (todos en `.mjs` bajo `scripts/test/harness/`, **fuera** de `extensions/` y de `suiteDirs`):

**`build-extension.mjs`** → `buildExtension(packageDir,{stubs})`
- Parametrizado por set de alias y por flag `--yes`/`--no-install` (no fusionar comportamientos)
- Payoff ~1000–1400 LOC

**`stubs.mjs`** → factorías nombradas
- `typeboxStub`/`typeboxValueStub`/`sdkStub`/`aiStub`/`tuiStub`
- Conservar variante typebox **con/sin `Integer`** (goal omite en `goal-verifier.test.mjs:78`, dynamic-workflows lo incluye en `composition-rank.test.mjs:54`)

**`fake-pi.mjs`** → `makePi()` base + `makeCtx(overrides)`
- Las suites mantienen sus diferencias como overrides
- Ejemplos: `confirmResult` plan-gate:123, `trusted` bg-jobs:89, `isIdle/usage` loop-caps-resume:175, `rows/width` mdview:92

**División de suites grandes (>500 LOC)** — **solo después** de extraer el harness (dividir antes multiplicaría copias):
- dynamic-workflow-composition.test.mjs: 820 LOC
- goal-verifier.test.mjs: 759 LOC
- loop-caps-resume.test.mjs: 731 LOC
- plan-approval.test.mjs: 669 LOC
- bg-jobs.test.mjs: 618 LOC
- goal-rehydrate.test.mjs: 591 LOC
- dashboard-usability-fixes.test.mjs: 536 LOC
- loop-behavior.test.mjs: 535 LOC

Partir por concern observable (p.ej. goal-verifier → veredicto / caps / persistencia), **moviendo escenarios completos sin reescribir aserciones**.

**Sincronización con `scripts/test/run-all.mjs`:**
- Mantener el guard existente (`run-all.mjs:96-101` aborta con exit 1 si una `*.test.mjs` en `suiteDirs` no está en `suites` ni en `ignoredDraftSuites`).
- El harness debe vivir fuera de `suiteDirs` para que `readdirSync(...).endsWith('.test.mjs')` no lo confunda con suite.
- Al partir: añadir cada archivo nuevo a `suites` (`run-all.mjs:36-59`) **en el mismo commit**.
- Usar `ignoredDraftSuites` (`:65-69`) solo para drafts con razón.

---

## 6. Restricciones de packaging / typecheck

### DO

- Colocar todo módulo nuevo a **profundidad uno:** `extensions/<dir>/<name>.ts` o `extensions/shared/<name>.ts` (ambos casan con `files: extensions/*/*.ts`, `package.json:14-15`).
- Importar con specifier `.js` explícito bajo NodeNext (`./mod.js`, `../shared/mod.js`), como `index.ts:45` → `./templates.js`. Exports nombrados + `export type` (patrón de `templates.ts`, isolatedModules-safe).
- Garantizar que cada sibling sea alcanzado por al menos un `index.ts` listado (typecheck root = `extensions/*/index.ts`, `package.json:21`), o nombrarlo `extensions/shared/index.ts` para ser root directo.
- Re-exportar desde `index.ts` todo símbolo que tests/otras extensiones ya importan (evita cambio de superficie).
- Verificar con `npm pack --dry-run` cualquier layout cross-dir (`../shared/*.js` no está probado hoy en el repo; solo existe `./templates.js` intra-dir).

### DON'T

- Crear `extensions/<dir>/<subdir>/<name>.ts` (profundidad dos) — **typechea y pasa tests locales pero se cae del tarball** → module-not-found tras publish (**Riesgo más alto de packaging**).
- Dejar un `.ts` que no sea `index.ts` y que nadie importe — **se empaqueta pero NO se typechea** (módulo huérfano; errores de tipo invisibles hasta la próxima edición) (Riesgo Medium).
- Añadir `extensions/shared/index.ts` a `pi.extensions` (`package.json:29-37`): es librería, no extensión.
- Renombrar/relocalizar contratos cross-extension: `ULTRACODE_MODE_EVENT`, tool `dynamic_workflow`, `PLAN_MODE_GUARD_SYMBOL`.

**Prueba positiva en repo:** `templates.ts` (1325 LOC) es la evidencia empírica de sibling depth-one empaquetado + typecheck transitivo + import `.js` (`index.ts:33-45`). Es el molde de referencia.

---

## 7. Roadmap incremental priorizado

Cada ronda = 1 Conventional Commit atómico, todo estructural (tidy-first), `npm test` verde antes/después. Empezar Low/alto-payoff.

### Fase 1 — Guardianes de prompts (Low, cero cambio de wording)

| # | Scope | Archivos | Qué se mueve/extrae | Verificación | Riesgo |
|---|---|---|---|---|---|
| 1.1 | `test(dynamic-workflows)` | nueva `*.test.mjs` + `run-all.mjs:36` | Test guardián byte-a-byte del bloque "Research-backed templates" (canonicaliza `##`/`###`, trim por línea) vs `formatWorkflowPatternCatalog()` | nueva suite + `npm test` | Low |
| 1.2 | `test(dynamic-workflows)` | nueva `*.test.mjs` + `run-all.mjs:36` | Test que ata las claves inyectadas en `makeUltracodePrompt`/`makeAlwaysOnUltracodeSystemPrompt` a `formatWorkflowPatternKeyList()` | nueva suite + `npm test` | Low |

### Fase 2 — Código compartido (Low→Medium, default-preserving, body-diff obligatorio)

| # | Scope | Archivos | Qué se mueve/extrae | Verificación | Riesgo |
|---|---|---|---|---|---|
| 2.1 | `refactor(shared)` | `extensions/shared/time.ts`, `pi-loop/index.ts`, `pi-goal/index.ts` | `formatEta` (pura, byte-idéntica) → import desde shared | loop-*+ goal-* suites + `npm test` | Low |
| 2.2 | `refactor(shared)` | `extensions/shared/state-store.ts`, loop/goal/dynamic-workflows/bg | `projectHash` (idéntica en 4 sitios) → shared | todas las suites afectadas + `npm test` | Low |
| 2.3 | `refactor(shared)` | `extensions/shared/state-store.ts`, `pandi-loop`, `pandi-goal` | `writeSidecarAtomic<T>` + `stateDir` dual-root (near-identical) | loop-caps-resume + goal-rehydrate + `npm test` | Medium |
| 2.4 | `refactor(shared)` | `extensions/shared/notify.ts`, plan/loop/goal/dynamic-workflows | `notify` 4 copias byte-idénticas (flag `stderrOnError` default off) | suites de las 4 + `npm test` | Low |
| 2.5 | `refactor(shared)` | `extensions/shared/session-state.ts`, plan/loop/goal | Solo kernel `collectLatestByKey` (NO cuerpos persist/rehydrate) | plan-approval + loop-caps-resume + goal-rehydrate + `npm test` | Low |

> Excluido deliberadamente de Fase 2: plegar `bg.appendEvent` al `appendJsonLine` con mutex (cambia concurrencia/error-handling — `bg-jobs.test.mjs`), folding de effort/mdview en `notify` (tipo de ctx distinto), cuerpos de C4 y esquemas C5.

### Fase 3 — Descomposición de monolitos (validar patrón en pequeñas → grandes)

| # | Scope | Archivos | Qué se mueve/extrae | Verificación | Riesgo |
|---|---|---|---|---|---|
| 3.1 | `refactor(effort)` | `pi-effort/parse.ts` + `index.ts` (re-export) | `parseEffortTarget` + aliases (puro) | effort-extension.test.mjs + `npm test` | Low |
| 3.2 | `refactor(auto-compact)` | `pi-auto-compact/threshold.ts` + `index.ts` | `parseThreshold`/`DEFAULT_THRESHOLD_PERCENT` (re-export para test `:122`) | auto-compact.test.mjs + `npm test` | Low |
| 3.3 | `refactor(mdview)` | `pi-mdview/path-resolve.ts` + `index.ts` | `stripWrappingQuotes`/`resolveMarkdownPath` (puro) — solo tras test de `~` expansion | mdview-extension.test.mjs + `npm test` | Low |
| 3.4 | `refactor(mdview)` | `pi-mdview/viewer-component.ts` + `index.ts` | `MarkdownViewComponent` + `padToWidth`/`boundedLine`/`createMarkdownTheme` + `VIEWER_*` | mdview-extension.test.mjs + `npm test` | Low |
| 3.5 | `refactor(plan)` | `pi-plan/gate.ts` + `index.ts` | gate puro (`isMutatingBash`,`blockedReason`,allowlist) | plan-gate.test.mjs (incl. caso false-positive) + `npm test` | Low |
| 3.6 | `refactor(plan)` | `pi-plan/prompts.ts` + `index.ts` | `makePlanningPrompt`/`makeImplementPrompt` + reglas canónicas (mata triple wording) | plan-approval.test.mjs + `npm test` | Low |
| 3.7 | `refactor(plan)` | `pi-plan/state.ts`, `ui.ts` + `index.ts` (re-export guard) | `activePlans`/`PLAN_MODE_GUARD`/persist/rehydrate + UI | plan-approval esc.5+6 + `npm test` | Medium |
| 3.8 | `refactor(bg)` | `pi-bg/storage.ts` + `index.ts` (re-export `atomicWriteJson`) | fs helpers puros (lowest risk) | bg-jobs + bg-extension + `npm test` | Low |
| 3.9 | `refactor(bg)` | `pi-bg/jobs.ts`, `runner.ts`, `commands.ts` + `index.ts` | id/discovery/`JobRegistry`/dispatch (tras tests de `activeJobs`/`Symbol.for`) | bg suites + `npm test` | Medium |
| 3.10 | `refactor(loop)` | `pi-loop/interval.ts`,`prompt.ts`,`guard.ts`,`status.ts` | leaf/puros primero (+ `splitTaskAndInterval`, `makeActiveLoop`) | loop-safety + loop-behavior + `npm test` | Low |
| 3.11 | `refactor(loop)` | `pi-loop/state.ts` + todos los módulos | globals (`activeLoops`/`wakeQueue`/`autopilotTurnInFlight`) + `resetState()` — **single owner** | 3 suites loop + `npm test` | Medium |
| 3.12 | `refactor(loop)` | `pi-loop/persistence.ts`,`scheduler.ts`,`lifecycle.ts`,`recovery.ts` + `index.ts` | resto, en ese orden | loop-caps-resume + `npm test` | Medium |
| 3.13 | `refactor(dynamic-workflows)` | `util.ts`,`workflow-files.ts`,`ultracode.ts`,`status-format.ts` | extracciones puras low-risk (probar la seam) | suites dynamic-workflows + `npm test` | Low |
| 3.14 | `refactor(dynamic-workflows)` | `agents.ts`,`graph.ts`,`runs.ts`,`lifecycle.ts` | concerns medianos | composition-* + `npm test` | Medium |
| 3.15 | `refactor(dynamic-workflows)` | `dashboard.ts` | God class TUI | dashboard-usability-fixes + editor-left-agents + `npm test` | Medium |
| 3.16 | `refactor(dynamic-workflows)` | `worker-source.ts` | blob (debe quedar byte-compatible; tras smoke test del worker) | composition + smoke worker + `npm test` | High |

> La síntesis se truncó tras la ronda 3.16 (la 3.17 `runtime.ts` quedó cortada). El roadmap completo está en `roadmap.json` del run; la Fase 4 (tests) se describe en §5.

---

## 8. Plan de verificación y métricas

- **Baseline:** `npm test` verde antes de tocar nada (typecheck + 23 suites de integración,
  ~20s); registrar LOC por archivo, #copias de funciones (`notify`×7, `formatEta`×2, etc.) y
  #copias de prompts (ver `scout-evidence.md`).
- **Por ronda:** re-correr la suite afectada y luego `npm test` completo; exigir verde antes
  de commitear. Si una ronda no se mantiene verde con un paso pequeño, revertir/bisectar y
  re-slice.
- **Move-only / byte-identical:** para extracciones puras, confirmar con `diff` que el código
  movido es idéntico (sólo `export`/import añadidos), como se hizo en 3.5.
- **Typecheck real de módulos nuevos:** confirmar que cada sibling es alcanzado por un
  `index.ts` (tsc sólo globa `extensions/*/index.ts`); marcar módulos huérfanos.
- **Packaging:** `npm pack --dry-run` para confirmar que cada módulo nuevo casa con
  `extensions/*/*.ts` y nada escapa a profundidad uno; `pi.extensions` sin cambios.
- **Métricas de mejora:** LOC por archivo y #clusters de código/prompt eliminados
  (grep/jscpd) antes/después.

## 9. Notas y limitaciones

- Analizadores: 8/9 por extensión válidos (`pandi-goal` falló schema) + 4/4 transversales.
- La síntesis se truncó al final de §7; `roadmap.json` tiene el roadmap completo (fases 1-3).
- Fase 4 (modularización de tests: harness/fixtures esbuild compartidos, ~1000-1400 LOC dup)
  está descrita en §5 pero aún NO ejecutada — es el mayor payoff pendiente y debe ir DESPUÉS
  del harness compartido para no multiplicar copias.
- Fase 1 (guardianes de prompts: el único duplicado byte-a-byte real es el bloque
  "Research-backed templates" en templates.ts + 3 docs) aún NO ejecutada.
