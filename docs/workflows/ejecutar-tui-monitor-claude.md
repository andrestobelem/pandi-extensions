# Plan de ejecución: TUI Monitor-first + patrones Claude

Fecha: 2026-06-25

Generado por workflow: `.pi/workflows/preparar-plan-ejecucion-tui-claude.js`

Run: `2026-06-25T06-44-52-676Z-preparar-plan-ejecucion-tui-claude-b6658e4d`

## Síntesis

## Diagnóstico profundo del cambio

El cambio real no es “mejorar una pantalla”: es convertir Dynamic Workflows de Pi de un **launcher/listado** a una **torre de control de ejecución**.

Estado actual verificado:

- No hay cambios de producto aún; solo untracked:
  - `.pi/workflows/preparar-plan-ejecucion-tui-claude.js`
  - `AGENTS.md`
- `extensions/dynamic-workflows.ts` concentra casi todo:
  - runtime;
  - persistencia de runs;
  - journal/resume;
  - dashboard TUI;
  - comandos `/workflow`;
  - tool `dynamic_workflow`.
- La TUI actual abre por defecto en `Workflows`:
  - `WorkflowDashboard` en `extensions/dynamic-workflows.ts:1560`.
- El widget live actual es grande y above-editor por defecto:
  - `formatLiveRunView()` en `extensions/dynamic-workflows.ts:1101`;
  - llamadas en `runWorkflowWithUi()` en `extensions/dynamic-workflows.ts:1784`.
- Pi ya persiste lo mínimo para un Monitor útil:
  - `status.json`;
  - `result.json`;
  - `events.jsonl`;
  - `journal.jsonl`;
  - artifacts por run.
- Pero Pi **no** tiene aún metadata rica tipo Claude:
  - no `ctx.meta`;
  - no `ctx.phase`;
  - no `label`, `phase`, `agentType`, `schema` en `AgentOptions`;
  - no tokens/cost/toolCalls/model por agente confiables.

Decisión conservadora: primero implementar una TUI **Monitor-first derivada de datos existentes**, sin prometer precisión de fases Claude-like. Después, añadir metadata/DSL para que el Monitor pase de heurístico a estructurado.

---

## MVP exacto a implementar primero

**MVP Fase 1: Monitor-first sin nueva DSL.**

Incluye:

1. `/workflows` abre en tab `Monitor`.
2. Tabs:
   - `[Monitor] [Runs] [Workflows] [Activity]`.
3. Monitor muestra, usando solo datos existentes:
   - run activo prioritario o último run;
   - workflow;
   - estado;
   - elapsed;
   - active/stale;
   - agents done/started;
   - bash done;
   - artifacts count;
   - último evento/log;
   - `runDir`;
   - hints de acciones.
4. Widget foreground:
   - máximo 2 líneas;
   - `belowEditor`;
   - width-safe.
5. Acciones seguras:
   - `enter`/`v`: view run;
   - `g`: graph del workflow;
   - `c`: cancel solo si run está `running` y activo;
   - `r`: rerun solo con confirmación y usando `input.json`; si falta input/workflow, fallback a editor JSON o acción deshabilitada;
   - `q`/`esc`: cerrar.
6. README actualizado.
7. No implementar todavía:
   - `ctx.meta`;
   - `ctx.phase`;
   - `ctx.parallel`;
   - `ctx.pipeline`;
   - `schema` real;
   - `workflowProgress[]` persistido;
   - tokens/cost/toolCalls/model si no existen.

---

## Plan por commits atómicos

Preflight opcional:

1. `docs(repo): add agent project instructions`
   - Solo `AGENTS.md`.
   - No mezclar con producto.

2. `chore(workflows): add monitor implementation workflow`
   - Solo `.pi/workflows/implementar-tui-monitor-claude.js`, si se decide versionarlo.

MVP TUI:

3. `feat(dynamic-workflows): derive monitor model from run data`
   - Añadir modelo derivado desde `WorkflowRunRecord`, logs, events y artifacts.
   - Sin UI compleja todavía.

4. `feat(dynamic-workflows): render compact workflow widget below editor`
   - Reemplazar/ajustar `formatLiveRunView`.
   - `ctx.ui.setWidget(..., { placement: "belowEditor" })`.

5. `feat(dynamic-workflows): add monitor-first dashboard tab`
   - `WorkflowDashboard` arranca en `monitor`.
   - Render monitor simple, width-safe.

6. `feat(dynamic-workflows): wire monitor view graph and cancel actions`
   - `enter/v`, `g`, `c`.
   - Reutilizar `cancelWorkflowRun`.

7. `feat(dynamic-workflows): add guarded workflow rerun action`
   - `r` con confirmación y `input.json`.
   - Si se considera demasiado riesgoso, mover este commit después del MVP.

8. `docs(dynamic-workflows): document monitor-first dashboard`
   - README: tabs, widget, atajos, límites de métricas.

Fases posteriores:

9. `feat(dynamic-workflows): persist workflow progress metadata`
10. `feat(dynamic-workflows): record agent labels phases and previews`
11. `feat(dynamic-workflows): expose ctx meta and phase helpers`
12. `feat(dynamic-workflows): add claude-like parallel and pipeline helpers`
13. `feat(dynamic-workflows): add untrusted fencing helper`
14. `docs(dynamic-workflows): document metadata and claude-like DSL`
15. `test(dynamic-workflows): add smoke fixtures for monitor and metadata`

---

## Archivos y funciones a tocar

### MVP

`extensions/dynamic-workflows.ts`

- Import:
  - añadir `visibleWidth` si hay padding/columnas ANSI.
- `workflowProgress(...)`
  - reutilizar para counts.
- Nuevo helper cerca de activity/dashboard:
  - `WorkflowMonitorModel`;
  - `deriveWorkflowMonitor(...)`;
  - `inferPhaseFromAgentName(...)` si se usa, marcado como heurístico;
  - `readRunEvents(...)` opcional, tolerante.
- `formatLiveRunView(...)`
  - compactar o reemplazar por widget width-aware.
- `runWorkflowWithUi(...)`
  - usar widget below-editor.
- `WorkflowDashboardResult`
  - añadir `cancel`, `rerun`.
- `WorkflowDashboard`
  - tab union incluye `monitor`;
  - default `monitor`;
  - `handleInput`;
  - `render`;
  - nuevo `renderMonitor`.
- `openWorkflowDashboard(...)`
  - despachar `view`, `graph`, `cancel`, `rerun`.
- `cancelWorkflowRun(...)`
  - reutilizar, no reescribir.
- `formatRunView(...)`
  - no debería requerir cambios salvo pequeños ajustes.

`README.md`

- Actualizar `/workflows`.
- Documentar Monitor-first, atajos y widget.
- Aclarar que métricas no persistidas no se muestran.

### Posterior metadata/DSL

`extensions/dynamic-workflows.ts`

- `AgentOptions`
- `SubagentResult`
- `WorkflowRunStatus`
- `WorkflowRunResult`
- `WorkflowRuntimeApi`
- `WORKFLOW_WORKER_SOURCE`
- `executeWorkflowCode(...).allowedMethods`
- host `api` dentro de `runWorkflow(...)`
- `runSubagent(...)`
- `sanitizeAgentOpts(...)`
- `transformWorkflowCode(...)`
- `WORKFLOW_TEMPLATE`
- `makeWorkflowGraph(...)`

---

## Qué queda para fases posteriores

Después del MVP:

1. `workflowProgress[]` persistido.
2. `ctx.meta(meta)`.
3. `ctx.phase(titleOrIndex)`.
4. `ctx.agent(prompt, { label, phase, agentType, schema })`.
5. Soporte metadata-only de `schema`; enforcement real solo si Pi CLI lo soporta.
6. `ctx.parallel(tasks, options?)` dentro del worker.
7. `ctx.pipeline(items, ...stages)` dentro del worker.
8. Compatibilidad parcial Claude:
   - `export const meta`;
   - aliases globales opcionales.
9. Seguridad/authoring:
   - `ctx.fenceUntrusted`;
   - docs de input validation;
   - prompts read-only;
   - patrones anti prompt-injection.
10. Monitor avanzado con fases reales, agentes por fase, previews y tres columnas.

---

## Diseño del workflow de implementación

Workflow sugerido: `.pi/workflows/implementar-tui-monitor-claude.js`.

Debe ser secuencial para edits y paralelo solo para reviews read-only.

Fases:

1. **Preflight**
   - Captura:
     - `git status --short`;
     - `git diff --stat`;
     - mapas de funciones.
   - Abort si `extensions/dynamic-workflows.ts` o `README.md` están dirty y no se pasa `allowDirtyTargets`.

2. **Implement slice**
   - Un solo agente editor.
   - Input recomendado:
     - `slice: "monitor-model"`;
     - `slice: "compact-widget"`;
     - `slice: "dashboard-monitor"`;
     - `slice: "actions"`;
     - `slice: "docs"`.
   - No hacer big bang.

3. **Check**
   - `git diff --check`;
   - typecheck/esbuild.

4. **Parallel review read-only**
   - Reviewer TUI width/input.
   - Reviewer runtime regressions.
   - Reviewer scope/docs.
   - Reviewer TS/null-safety.

5. **Synthesis**
   - Primera línea obligatoria:
     - `FIX_REQUIRED: yes`
     - o `FIX_REQUIRED: no`.

6. **Fix**
   - Un solo agente editor.
   - Solo bloqueantes.
   - Máximo 1 pasada.

7. **FinalCheck**
   - Comandos deterministas.
   - Artifact final con diff, checks y riesgos aceptados.

No hacer commits desde el workflow; commitear manualmente tras cada slice.

---

## Criterios de aceptación

MVP acepta si:

- `/workflows` abre `Monitor` por defecto.
- Tabs visibles: `Monitor`, `Runs`, `Workflows`, `Activity`.
- Widget live:
  - máximo 2 líneas;
  - below-editor;
  - se limpia al terminar/fallar.
- `render(width)` no excede `width`.
- `handleInput` llama `requestRender()` tras mutaciones.
- Runs antiguos siguen visibles.
- Runs `running`, `completed`, `failed`, `cancelled`, `stale` se muestran correctamente.
- No se muestran tokens/cost/toolCalls/model como reales.
- `enter/v`, `g`, `c`, `r`, `q/esc` se comportan como documentado.
- `/workflow list/run/start/resume/cancel/view` siguen funcionando.
- README coincide con UX real.

---

## Comandos de verificación

```bash
git status --short
git diff --check
git diff --stat
```

Type/build smoke:

```bash
./node_modules/.bin/tsc --noEmit --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext --types node extensions/dynamic-workflows.ts

npx --yes esbuild extensions/dynamic-workflows.ts \
  --platform=node \
  --format=esm \
  --packages=external \
  --outfile=/tmp/pi-dynamic-workflows-check.mjs
```

Smoke manual:

```bash
PI_DYNAMIC_WORKFLOWS_PI_COMMAND=true pi --no-extensions -e ./extensions/dynamic-workflows.ts
```

Dentro de Pi:

```text
/workflow list
/workflow start smoke-monitor {"maxAgents":1,"concurrency":1}
/workflows
/workflow view latest
/workflow cancel latest
```

---

## Riesgos principales

- **Scope creep:** mezclar Monitor con DSL/runtime.
- **Overflow TUI:** ANSI/emojis sin `truncateToWidth`/`visibleWidth`.
- **Métricas falsas:** tokens/cost/toolCalls no existen hoy.
- **Rerun caro/peligroso:** debe confirmar y usar input controlado.
- **Cancel engañoso:** solo activo/background vía `activeRuns`.
- **Fases falsas:** hasta `ctx.phase`, cualquier fase es heurística.
- **Regresión runtime:** `extensions/dynamic-workflows.ts` es un archivo grande y crítico.
- **Workflow implementador big bang:** evitar edición amplia en una sola pasada.

---

## Abort conditions

Abortar si:

- Hay cambios previos en `extensions/dynamic-workflows.ts` o `README.md` sin permiso explícito.
- El diff MVP toca `AgentOptions`, `WorkflowRuntimeApi`, worker, journal, resume o cache.
- Se implementa `ctx.meta`, `ctx.phase`, `ctx.parallel`, `ctx.pipeline` en MVP.
- Se agregan tokens/cost/model/toolCalls como datos reales.
- `render(width)` puede exceder `width`.
- `rerun` no pide confirmación.
- `cancel` intenta cancelar runs no activos.
- `git diff --check`, `tsc` o `esbuild` fallan.
- Review synthesis marca bloqueantes después de una pasada de fix.
- El diff supera ~300 líneas sin justificación clara.

Plan final: **MVP Monitor-first conservador primero; metadata/DSL Claude-like después, en commits separados y backward-compatible.**

## Estado de implementación

Continuación verificada el 2026-06-25:

- El workflow `.pi/workflows/implementar-tui-monitor-claude.js` aplicó el MVP Monitor-first, pero el run `2026-06-25T06-55-25-442Z-implementar-tui-monitor-claude-9dedaac1` terminó en `failed` por timeout global de 1200s durante reviews.
- Antes del timeout, el diff pasó `git diff --check` y `esbuild`.
- Revisión manual posterior confirmó que el código conserva fallback RPC para widgets (`string[]`) y usa component factory solo en `ctx.mode === "tui"`.
- Verificaciones posteriores ejecutadas desde el repo:
  - `git diff --check`
  - `npx --yes esbuild extensions/dynamic-workflows.ts --platform=node --format=esm --packages=external --outfile=/tmp/pi-dynamic-workflows-check.mjs`
  - `node --check .pi/workflows/preparar-plan-ejecucion-tui-claude.js && node --check .pi/workflows/implementar-tui-monitor-claude.js`
  - `tsc --noEmit --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext --types node extensions/dynamic-workflows.ts`
  - `pi --no-extensions -e ./extensions/dynamic-workflows.ts --list-models __no_such_model__`
  - `pi --no-extensions -e ./extensions/dynamic-workflows.ts --no-session -p "/workflow list"`
  - `pi --no-extensions -e ./extensions/dynamic-workflows.ts --no-session -p "/workflow runs"`
  - `pi --no-extensions -e ./extensions/dynamic-workflows.ts --no-session -p "/workflow view latest"`
- Riesgo aceptado: no se ejecutó smoke manual interactivo de `/workflows` en una TUI real dentro de esta continuación.

## Artefactos

- Run dir: `/Users/andrestobelem/ws/at/pi-dynamic-workflows/.pi/workflow-runs/2026-06-25T06-44-52-676Z-preparar-plan-ejecucion-tui-claude-b6658e4d`
- Contexto: `/Users/andrestobelem/ws/at/pi-dynamic-workflows/.pi/workflow-runs/2026-06-25T06-44-52-676Z-preparar-plan-ejecucion-tui-claude-b6658e4d/context.json`
- Reviews: `/Users/andrestobelem/ws/at/pi-dynamic-workflows/.pi/workflow-runs/2026-06-25T06-44-52-676Z-preparar-plan-ejecucion-tui-claude-b6658e4d/reviews.json`
- Agentes: `/Users/andrestobelem/ws/at/pi-dynamic-workflows/.pi/workflow-runs/2026-06-25T06-44-52-676Z-preparar-plan-ejecucion-tui-claude-b6658e4d/agents/`
