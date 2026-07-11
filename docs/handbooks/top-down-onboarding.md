# Onboarding top-down para programadores

Esta guía es el mapa corto para entender `pandi-extensions` sin perderse en los detalles. Empezá por el propósito del repo, bajá por subsistemas y recién después entrá a archivos concretos. Usala también como checklist cuando revises comentarios o prosa traducida: claridad primero, sin tocar tokens que el código parsea.

## En 30 segundos

`pandi-extensions` empaqueta una suite de extensiones para Pi/Pandi: comandos UX, memoria, planificación, loops, goals, worktrees, containers, diagnósticos TypeScript, documentación, tema visual y, como núcleo más complejo, `pandi-dynamic-workflows`.

La idea central es: **convertir patrones agénticos en herramientas ejecutables, observables y verificables**.

Tres anclas para orientarte:

- `README.md` explica el producto y la ruta de instalación.
- `extensions/pandi-dynamic-workflows/` contiene el runtime de dynamic workflows, el patrón `router`, dashboards, reports y artifacts.
- `extensions/<extension>/tests/integration/` + `extensions/shared/test/` sostienen el loop de desarrollo seguro.

## Ruta rápida de lectura

Si tenés poco tiempo, leé en este orden:

1. `README.md`
2. `package.json` — scripts, paquetes y extensiones publicadas.
3. `AGENTS.md` — reglas de ingeniería del repo.
4. `docs/dynamic-workflows.md`
5. `extensions/pandi-dynamic-workflows/README.md`
6. `extensions/pandi-dynamic-workflows/ARCHITECTURE.md`
7. `extensions/pandi-dynamic-workflows/index.ts`
8. `extensions/pandi-dynamic-workflows/surface/index.ts`
9. `extensions/pandi-dynamic-workflows/runtime/index.ts`
10. `extensions/pandi-dynamic-workflows/lifecycle/index.ts`
11. `extensions/pandi-dynamic-workflows/observe/index.ts`
12. `docs/scaffolds/index.md`
13. `extensions/pandi-dynamic-workflows/scaffolds/*.js`

## Mapa top-down del repo

| Capa | Qué resuelve | Dónde mirar |
| --- | --- | --- |
| Producto instalable | Suite de extensiones, skills y docs para Pi/Pandi | `README.md`, `package.json`, `docs/setup.md` |
| Runtime agéntico | Workflows JS, subagentes, artifacts, resume, reports | `extensions/pandi-dynamic-workflows/` |
| Disciplina de ejecución | Plan antes de mutar, goals verificables, loops seguros, jobs background | `pandi-plan`, `pandi-goal`, `pandi-loop`, `pandi-bg` |
| Operaciones dev | Worktrees, containers, TypeScript diagnostics, doctor | `pandi-worktree`, `pandi-container`, `pandi-typescript-lsp`, `pandi-doctor` |
| UX e interacción | Persona Pandi, menús, preguntas laterales, mejora de prompts, nombres de sesión | `pandi`, `pandi-ask`, `pandi-btw`, `pandi-improve-prompt`, `pandi-rename` |
| Contexto y lectura | Memoria local, auto-compactación, Markdown viewer, tema visual | `pandi-local-memory`, `pandi-auto-compact`, `pandi-mdview`, `pandi-theme` |
| Tests compartidos | Harness aislado y helpers para suites de integración | `extensions/shared/test/` |

### Núcleo: `pandi-dynamic-workflows`

Pensalo como el laboratorio del repo. Registra comandos/tools, resuelve workflows, ejecuta JavaScript confiable en un `Worker`, spawnea subagentes, escribe artifacts y deja evidencia reanudable.

Flujo mental:

```text
humano/modelo
  → /workflow o dynamic_workflow
  → surface/command-handlers.ts
  → surface/resolve.ts
  → lifecycle/start.ts
  → runtime/engine.ts
  → runtime/worker-bridge.ts + runtime/worker-source.ts
  → subagents/bash/artifacts
  → observe/writer.ts + tui/
  → .pi/workflows/runs/<run-id>/
```

Archivos clave:

- [`ARCHITECTURE.md`](../../extensions/pandi-dynamic-workflows/ARCHITECTURE.md) — mapa canónico de deep modules y sus fachadas.
- `index.ts` — activación de la extensión; no contiene el engine.
- `surface/command-handlers.ts` — handlers de `/workflow` y `/workflows`.
- `surface/resolve.ts` — `listWorkflows`, `resolveWorkflow` y `resolveWorkflowForRun`.
- `runtime/worker-source.ts` — globals inyectados dentro del workflow; `runtime/engine.ts` exporta `runWorkflow`.
- `lifecycle/index.ts` — fachada de start, resume, cancel, cleanup, status y registry; `runtime/runs.ts` lista y resuelve runs.
- `surface/catalog.ts`, `surface/pattern-scaffolds.ts` y `scaffolds/*.js` — catálogo de patrones.
- `tui/dashboard.ts` y `observe/writer.ts` (`writeRunReport`) — superficies de inspección.

### Disciplina de ejecución

Este grupo existe para que el agente no “haga cosas” sin control:

- `pandi-plan`: modo plan read-only antes de cambios no triviales.
- `pandi-goal`: criterios de éxito, progreso y verificación independiente.
- `pandi-loop`: ejecución iterativa con scheduling y safeguards.
- `pandi-bg`: comandos largos en background, con logs y estado.

Preguntas guía:

- ¿Qué bloquea `/plan` y qué permite?
- ¿Qué evidencia necesita `/goal` para declarar `done`?
- ¿Cómo evita `/loop` iteraciones automáticas peligrosas?
- ¿Por qué `/bg` no reemplaza a `dynamic_workflow`?

Lectura rápida de estados:

| Extensión | Campo de ciclo de vida | Valores | Fuente |
| --- | --- | --- | --- |
| `pandi-plan` | `status` + `active` | `planning`, `approved`, `rejected`, `exited`, `planned`; `active` indica si el gate read-only sigue armado | `extensions/pandi-plan/state.ts` |
| `pandi-goal` | `gstatus` | `pursuing`, `verifying`, `verifying-independent`, `done`, `blocked`, `stopped`, `stale` | `extensions/pandi-goal/types.ts` |
| `pandi-loop` | `status` | `running`, `paused`, `stopped`, `done`, `failed`, `stale` | `extensions/pandi-loop/state.ts` |

`pandi-goal` usa `gstatus` porque `GoalAssessment.status` ya nombra la decisión puntual de una autoevaluación (`continue`, `done`, `blocked`). No lo unifiques a mano: primero distinguí “estado durable del ciclo” de “veredicto de una iteración”.

Dos pares de nombres que conviene separar:

| Término | Pertenece a | Qué significa |
| --- | --- | --- |
| **Run** | `pandi-dynamic-workflows` | Ejecución de un workflow con `runId`, `runDir`, `status.json`, artifacts, subagentes y journal/resume. |
| **Job** | `pandi-bg` | Proceso background local para un comando largo, con `jobId`, logs, `JobStatus` y artifacts. No modela composition ni subagentes. |
| **Workflow graph** | `workflow-graph.ts` | Introspección estática de un archivo workflow para previsualizar llamadas (`agent`, `agents`, `pipeline`, `workflow`, etc.). |
| **Subtask graph** | scaffold `orchestrator-workers` | Grafo runtime de tareas `dependsOn` propuesto por un agente planner; no es el mismo tipo que `WorkflowGraphModel`. |

### Operaciones de desarrollo

Este grupo toca el sistema o el entorno:

- `pandi-worktree`: maneja worktrees sin mover el `cwd` actual.
- `pandi-container`: corre comandos Linux en micro-VMs Apple `container`.
- `pandi-typescript-lsp`: expone diagnósticos `tsc --noEmit`.
- `pandi-doctor`: revisa instalación, dependencias y setup.

Preguntas guía:

- ¿Qué comando externo ejecuta cada extensión?
- ¿Qué parte se puede testear con harness aislado?
- ¿Qué depende de macOS, Apple Silicon, git, Node o `tsc`?

### UX, contexto y lectura

Este grupo define cómo se siente usar Pandi:

- `pandi`: cara, prompt/persona, spinner y detalles de presentación.
- `pandi-ask`: tools interactivas `ask_choice` y `ask_confirm`.
- `pandi-btw` e `pandi-improve-prompt`: overlays para preguntar/mejorar sin contaminar el flujo.
- `pandi-local-memory`: notas durables en `.pi/memory/`.
- `pandi-auto-compact`: compactación y snapshots de contexto.
- `pandi-mdview`: visor Markdown desde la TUI.

Preguntas guía:

- ¿Este texto lo ve una persona o lo parsea una máquina?
- ¿El estado persistido vive en `.pi/`, en memoria del runtime o en archivos del proyecto?
- ¿Qué superficie debe ser cálida y cuál debe ser estrictamente contractual?

## Equipo de programadores

Dividí el trabajo por responsabilidad, no por archivos al azar.

| Rol | Scope | Entregable |
| --- | --- | --- |
| Arquitectura runtime | `pandi-dynamic-workflows` | Diagrama `/workflow` → run dir, invariantes del Worker y lista de tests relevantes |
| Seguridad y disciplina | `pandi-plan`, `pandi-goal`, `pandi-loop`, `pandi-bg` | Matriz acción → permitida/bloqueada/confirmada, riesgos best-effort y tests de gates |
| Developer operations | `pandi-worktree`, `pandi-container`, `pandi-typescript-lsp`, `pandi-doctor` | Tabla de side-effects, dependencias de plataforma y comandos de verificación |
| UX/prosa | comandos human-facing y comentarios | Tabla `path → problema → propuesta`, separada de cambios de comportamiento |
| Contexto/docs/tests | memoria, compactación, mdview, theme, `shared` | Mapa de datos persistidos, riesgos de prompt injection y guía para tests |

Definition of Done común:

- El rol puede explicar el subsistema sin abrir todo el repo.
- Todo claim importante cita un path, test, comando o artifact.
- Los cambios propuestos separan **comportamiento** de **prosa/estructura**.
- Si se toca código, hay test representativo o una razón explícita de por qué no aplica.

## Comentarios y prosa traducida

La regla base: **si lo parsea el código, no se traduce; si lo lee una persona, debe sonar claro en español**.

Prioridad de revisión:

1. Comentarios que contradicen o simplifican mal el código.
2. Falsos amigos o traducciones que cambian el sentido técnico.
3. Texto user-facing inconsistente entre inglés y español.
4. Spanglish que no aporta precisión.

Ejemplos semilla para revisar antes de editar:

| Prioridad | Path/frase | Problema | Dirección de corrección |
| --- | --- | --- | --- |
| Alta | `extensions/pandi-goal/persistence.ts` — “tragar errores” | Puede sugerir que toda persistencia ignora errores, cuando solo el sidecar es best-effort | Aclarar qué llamada mantiene errores y cuál los ignora |
| Alta | `extensions/pandi-goal/verifier.ts` — “clamó” | Falso amigo de `claimed`; suena a gritar/proclamar | Usar “afirmó” |
| Media | `extensions/pandi-goal/prompts.ts` — referencia a `index.ts` | El verificador vive en `verifier.ts` | Actualizar path conceptual |
| Media | `extensions/pandi-goal/index.ts` — estados activos | Puede omitir `verifying-independent` | Enumerar todos los estados relevantes |
| Media | `extensions/pandi-goal/time.ts` / `pandi-loop/time.ts` — `null -> "now"` | Puede sonar a wake inmediato | Decir que es etiqueta fallback sin timestamp programado |
| Media | `extensions/pandi-loop/index.ts` — “force-stoppea”, “loopear” | Spanglish innecesario en texto humano | “fuerza la detención”, “ejecutar iteraciones automáticas” |
| Media | `extensions/pandi-dynamic-workflows/*` cabeceras en inglés | Comentarios explicativos humanos quedan menos directos | Traducir explicación, conservar nombres API |
| Media | `extensions/pandi-improve-prompt/*` UX en inglés | Superficie user-facing inconsistente | Llevar mensajes visibles a español claro |
| Baja | `AGENTS.md` — `owner user` | Calco del inglés | “del usuario `andrestobelem`” |

Antes de tocar cualquiera de estos puntos, revalidá con `rg` porque las líneas exactas pueden moverse:

```bash
rg -n "clamó|force-stoppea|loopear|tragar errores|owner user|read-time|reaped" .
```

## Glosario mínimo

### Dejar en inglés

No traduzcas comandos, APIs, eventos, nombres de tools, literales parseables ni nombres de paquetes:

- `/workflow`, `/workflows`, `/dynamic-workflow`, `/ultracode`
- `dynamic_workflow`, `agent`, `agents`, `workflow`
- `ask_choice`, `ask_confirm`
- `goal_progress`, `loop_schedule`, `loop_stop`
- `runId`, `runDir`, `cwd`
- `Worker`, `CommonJS`, `JSONL`
- `VERDICT: PASS/FAIL`, `NO_FINDINGS`, `INSUFFICIENT_EVIDENCE`
- `status.json`, `result.json`, `events.jsonl`
- `pandi-dynamic-workflows`, `pandi-auto-compact`, etc.

### Traducir o adaptar

Preferí español claro para explicación humana:

- `default` → `predeterminado`
- `claimed` → `afirmó`
- `read-time` → `al leer` / `en tiempo de lectura`
- `force-stop` → `forzar la detención`
- `looping` → `iteraciones automáticas` / `sostener un loop`
- `agentic` → `agéntico`, salvo nombre propio o cita literal
- `in flight` → `en ejecución`
- `re-launch` → `relanzamiento`
- `scheduling` → `programación de wakes` o `planificación de ejecución`

Para prompts, usá también [`glosario-prompts.md`](./glosario-prompts.md): ahí vive la lista más estricta de tokens congelados.

## Cómo verificar cambios futuros

Comandos base antes de merge:

```bash
npm run doctor
npm test
```

Checklist por tipo de cambio:

| Tipo de cambio | Verificación mínima |
| --- | --- |
| Runtime | Test de integración representativo en `extensions/<extension>/tests/integration/*` + `npm test` |
| Prosa user-facing | Buscar snapshots/assertions sobre strings; actualizar README si cambia UX |
| Docs Markdown | `npx markdownlint-cli2 ':ruta.md'` + `npm run sync:docs:html` + `npm run -s sync:docs:html:check` |
| Dynamic Workflows | Revisar primitives parity, scaffolds packaging, resume/journal, reports y skill mirrors |
| Comentarios internos | Mantener el cambio separado de comportamiento; no mezclar con refactors amplios |

## Gaps conocidos

Esta guía salió de una lectura top-down y una auditoría read-only. No reemplaza una revisión exhaustiva línea por línea.

Gaps a recordar:

- No se ejecutó Pi real ni TUI real para validar cada flujo descrito.
- No se corrieron tests durante la auditoría original; los comandos de verificación quedan para la fase de implementación.
- No se inspeccionó cada scaffold JS uno por uno.
- Los ejemplos de comentarios/prosa son semillas priorizadas, no inventario completo.
- `docs/html/` es mirror generado: nunca lo edites a mano; regeneralo desde Markdown.
