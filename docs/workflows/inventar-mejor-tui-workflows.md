# Workflow: inventar mejor TUI de workflows

Fecha: 2026-06-25
Workflow: `.pi/workflows/inventar-mejor-tui-workflows.js`

## Objetivo

Lanzar un workflow dinámico para inventar una visualización TUI de workflows mucho mejor, inspirada en Claude Code pero adaptada y superior para Pi.

## Referencias usadas

Capturas locales provistas por el usuario:

- `/Users/andrestobelem/Desktop/Captura de pantalla 2026-06-25 a la(s) 02.29.20.png`
- `/Users/andrestobelem/Desktop/Captura de pantalla 2026-06-25 a la(s) 02.29.27.png`

Investigación web previa:

- Claude Code dynamic workflows usa `/workflows` con fases, agentes, métricas, detalles por agente, pausa/stop/save y filtros de estado.

## Diseño del workflow

Subagentes:

1. `referencia-claude-y-capturas`
   - Analiza capturas e identifica elementos visuales/UX.
2. `factibilidad-pi-tui`
   - Revisa API TUI de Pi y el código actual.
3. `ux-mejor-que-claude`
   - Propone una experiencia superior con wireframes ASCII.
4. `critico-riesgos-y-scope`
   - Revisa riesgos, alcance y criterios de aceptación.
5. `sintesis-plan-tui`
   - Sintetiza un plan implementable.

## Run

Run ID:

```text
2026-06-25T05-33-29-104Z-inventar-mejor-tui-workflows-235f5326
```

Estado inicial: `running` en background.

Estado posterior: cancelado manualmente porque quedó activo sin generar artefactos de agentes ni procesos `pi -p` visibles. Se creó una versión secuencial/liviana: `.pi/workflows/inventar-mejor-tui-workflows-lite.js`.

Límites:

- `concurrency`: 4
- `maxAgents`: 6
- `timeoutMs`: 900000
- `agentTimeoutMs`: 600000

## Artefactos esperados

- `context.json`
- `design-reviews.json`
- `plan-tui-workflows.md`
- `agents/*.md`

## Plan actualizado: TUI Monitor-first

Investigación posterior:

- Workflow Pi ejecutado: `.pi/workflows/investigar-mejor-tui.js`
- Run: `2026-06-25T06-03-22-448Z-investigar-mejor-tui-5fa5f974`
- Artefacto principal: `.pi/workflow-runs/2026-06-25T06-03-22-448Z-investigar-mejor-tui-5fa5f974/investigacion-mejor-tui.md`

Decisión de producto:

- `/workflows` debe abrir una vista **Monitor-first**, no una lista de workflows.
- La TUI debe contestar rápido:
  1. qué corre ahora;
  2. si sigue vivo;
  3. dónde está trabado o falló;
  4. qué puede hacer el usuario;
  5. dónde está la evidencia/artifacts.

MVP inmediato:

1. Crear un modelo derivado de monitor desde `status.json`, `events.jsonl` y logs.
2. Reemplazar `formatLiveRunView` por un widget compacto de máximo 2 líneas.
3. Mostrar el widget con `ctx.ui.setWidget(..., { placement: "belowEditor" })`.
4. Cambiar `WorkflowDashboard` para incluir tab inicial `Monitor`:
   - `[Monitor] [Runs] [Workflows] [Activity]`.
5. Renderizar el Monitor con layout responsive:
   - ancho amplio: fases / agentes / detalle-actividad;
   - ancho estrecho: layout apilado.
6. Añadir acciones reales desde el dashboard:
   - `v` / enter: view run;
   - `g`: graph workflow;
   - `r`: rerun desde `input.json`;
   - `c`: cancel si el run está activo;
   - `q` / esc: cerrar.
7. No mostrar métricas que Pi todavía no persiste: tokens/tools/cost/model reales deben aparecer como `—` o no aparecer.

Wireframe objetivo:

```text
Pi Dynamic Workflows   [Monitor] [Runs] [Workflows] [Activity]

▶ resume-design  running  2m01s · agents 0/3 · bash 0 · artifacts 2
run 2026-06-25T...235f5326 · last event 14s ago · c cancel

┌ Phases ────────┬ Agents: Design ───────────────┬ Detail / Activity ───────┐
│ › Design  0/3  │ ● design:pragmatic   1m28s    │ selected: design:api-ux   │
│   Merge   0/1  │ ● design:robust      1m17s    │ state: running            │
│   Review  0/1  │ ● design:api-ux      1m09s    │ artifact: pending         │
│   Synth   0/1  │                                │ Recent                    │
│ Progress       │ tok — · tools — · model —      │ 02:29 workflow start      │
│ Design [██░]   │                                │ 02:30 agent start api-ux  │
└────────────────┴────────────────────────────────┴───────────────────────────┘

↑↓ select · ←→ phase · enter/v view · g graph · r rerun · c cancel · q/esc close
```

## Investigación adicional: código real de workflows de Claude

Se revisaron workflows reales en `~/.claude`:

- `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/code-modernization/workflows/extract-rules.js`
- `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/code-modernization/workflows/harden-scan.js`
- `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/code-modernization/workflows/portfolio-assess.js`
- `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/code-modernization/workflows/reimagine-scaffold.js`
- `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/code-modernization/workflows/uplift-deltas.js`
- `~/.claude/projects/-Users-andrestobelem-ws-at-pi-dynamic-workflows/696d49f5-a038-4f7f-a735-18d6d6d1940f/workflows/scripts/resume-design-wf_fc27859c-fda.js`
- `~/.claude/projects/-Users-andrestobelem-ws-at-pi-dynamic-workflows/696d49f5-a038-4f7f-a735-18d6d6d1940f/workflows/scripts/resume-implement-wf_80a1a442-d89.js`
- `~/.claude/projects/-Users-andrestobelem-ws-at-workflows/97edf3f1-af4a-4363-864a-60af81b1c326/workflows/scripts/investigate-dynamic-workflows-wf_37e5f3b9-6c2.js`

Patrones clave de Claude que debemos incorporar al plan:

1. **`meta` declarativo**
   - Claude declara `name`, `description`, `whenToUse` y `phases` al inicio del workflow.
   - Esto evita inferir fases por regex y permite que la TUI conozca la estructura antes de que corran agentes.

2. **`phase('Name')` explícito**
   - El workflow marca la fase activa con llamadas `phase(...)`.
   - La TUI puede mostrar fase actual, progreso por fase y transiciones sin adivinar.

3. **Agentes con metadata rica**
   - Claude llama `agent(prompt, { label, phase, agentType, schema })`.
   - `label` da identidad visual (`find:auth`, `verify:CWE-89`, `design:robust`).
   - `agentType` identifica rol/preset.
   - `schema` permite structured output y mejora previews/resultados.

4. **Primitivas de orquestación**
   - `parallel([...])` para fan-out.
   - `pipeline(items, stage1, stage2, ...)` para map-reduce / procesamiento por etapas.
   - Esto produce workflows más legibles que loops manuales con `ctx.agents`.

5. **`workflowProgress` persistido**
   - Los JSON de Claude guardan un arreglo rico con:
     - fases (`workflow_phase`);
     - agentes (`workflow_agent`);
     - `label`, `phaseIndex`, `phaseTitle`, `agentId`, `agentType`;
     - `model`, `state`, `startedAt`, `queuedAt`, `lastProgressAt`;
     - `lastToolName`, `lastToolSummary`, `tokens`, `toolCalls`, `durationMs`;
     - `promptPreview`, `resultPreview`, `error`.
   - Esto es exactamente lo que una TUI excelente necesita; Pi hoy solo tiene logs y artifacts.

6. **Journal rico por subagente**
   - Claude escribe `subagents/workflows/<runId>/journal.jsonl` con eventos `started` / `result`, `key` y `agentId`.
   - También guarda `agent-*.meta.json` y `agent-*.jsonl` por subagente.
   - Sirve para inspección, resume/idempotencia y monitor preciso.

7. **Disciplina de seguridad en workflows oficiales**
   - Validación estricta de `args` antes de interpolarlos en paths/prompts.
   - Fencing de datos no confiables: `<<<UNTRUSTED ... UNTRUSTED>>>`.
   - Repetición explícita de reglas anti prompt-injection dentro de cada prompt.
   - Agentes read-only cuando corresponde.
   - Separación de responsabilidades: los agentes investigan/devuelven estructura; la sesión llamadora escribe archivos sensibles.

## Plan de evolución inspirado en Claude

### Fase 1: TUI sin cambiar DSL

Implementar el MVP Monitor-first usando datos existentes:

- logs;
- `status.json`;
- `events.jsonl`;
- artifacts;
- heurística de fases desde labels/nombres (`design:robust` → `design`).

### Fase 2: metadata runtime para mejorar la TUI

Extender `AgentOptions` y persistencia interna:

```ts
interface AgentOptions {
  name?: string;
  label?: string;
  phase?: string;
  agentType?: string;
  schema?: unknown;
}
```

Persistir eventos ricos:

```ts
type WorkflowProgressEvent =
  | { type: "workflow_phase"; index: number; title: string; detail?: string }
  | {
      type: "workflow_agent";
      index: number;
      label: string;
      phaseIndex?: number;
      phaseTitle?: string;
      agentId?: string;
      agentType?: string;
      model?: string;
      state: "queued" | "running" | "done" | "error" | "cancelled";
      startedAt?: number;
      queuedAt?: number;
      lastProgressAt?: number;
      lastToolName?: string;
      lastToolSummary?: string;
      tokens?: number;
      toolCalls?: number;
      durationMs?: number;
      promptPreview?: string;
      resultPreview?: string;
      error?: string;
    };
```

### Fase 3: DSL compatible con Claude en Pi

Añadir helpers al runtime:

```js
module.exports = async function workflow(ctx, input) {
  ctx.meta({
    name: "repo-audit",
    phases: [
      { title: "Find", detail: "one finder per area" },
      { title: "Verify", detail: "one refuter per finding" },
      { title: "Synthesize" },
    ],
  });

  await ctx.phase("Find");

  const findings = await ctx.parallel(
    areas.map((area) => () =>
      ctx.agent(`Review ${area}`, {
        label: `find:${area}`,
        phase: "Find",
        agentType: "auditor",
        schema: FINDINGS_SCHEMA,
      })
    )
  );

  await ctx.phase("Synthesize");
  return await ctx.agent("Synthesize findings", {
    label: "synthesis",
    phase: "Synthesize",
  });
}
```

Helpers a agregar:

- `ctx.meta(meta)`
- `ctx.phase(titleOrIndex)`
- `ctx.parallel(tasks, options?)`
- `ctx.pipeline(items, ...stages)`
- `ctx.agent(prompt, { label, phase, agentType, schema })`
- `ctx.agents(items, { phase, label })`

### Fase 4: seguridad y ergonomía de authoring

Tomar de Claude los patrones oficiales:

- validar `input`/`args` antes de interpolar paths;
- helper `ctx.fenceUntrusted(value)` o documentar patrón `<<<UNTRUSTED ... >>>`;
- presets de prompts read-only;
- guía para que workflows largos devuelvan estructura y no escriban archivos salvo que sea intencional;
- structured output con `schema` cuando Pi pueda soportarlo de forma confiable.

## Próximos pasos

1. Implementar MVP Monitor-first en `extensions/dynamic-workflows.ts`.
2. Actualizar README con la nueva vista Monitor y atajos.
3. Validar manualmente:
   - foreground run con muchos logs;
   - background run + `/workflows`;
   - cancel desde dashboard;
   - terminales de 50/80/120 columnas;
   - run `stale`;
   - run failed/cancelled;
   - modo print/json sin TUI.
4. Después del MVP, implementar metadata declarativa tipo Claude:
   - `ctx.meta`;
   - `ctx.phase`;
   - `label`, `phase`, `agentType`, `schema` en `ctx.agent`;
   - `workflowProgress[]` persistido.
5. Luego agregar helpers de authoring:
   - `ctx.parallel`;
   - `ctx.pipeline`;
   - `ctx.fenceUntrusted`.

## Mejora adicional detectada

El usuario pidió que los workflows en background despierten al agente al terminar. Se implementó en `extensions/dynamic-workflows.ts`: al completar o fallar un background workflow, Pi envía un follow-up automático con el `runId` para que el agente inspeccione el run y continúe.
