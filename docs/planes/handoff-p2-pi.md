# Handoff a Pi — Implementar P2 (paridad con Claude Dynamic Workflows)

Brief para que Pi implemente **P2** (capacidades avanzadas). **Requiere P0 y P1 hechos** (en especial la
migración a `--mode json` de P1.0, que P2.1 reusa). Plan + decisiones:
`docs/planes/2026-06-25-paridad-claude-dynamic-workflows.md` (§3, §4 D1–D6). Todo en
**`extensions/dynamic-workflows.ts`** salvo docs.

## Objetivo y alcance
P2 = cuatro tareas independientes entre sí: **P2.1** budget, **P2.2** determinismo, **P2.3**
`ctx.workflow()` (composición), **P2.4** `isolation:"worktree"`. Hacerlas de a una, esbuild tras cada una.

**Reglas duras:** no romper resume/ultracode/P0/P1; cambios aditivos/opt-in; no agregar deps; confirmar
anclajes con grep.

> **Decisión del usuario:** D5 quedó en **default `'seed'`** (determinismo por defecto, como Claude; opt-out
> `determinism:'off'`). D3 ya está aplicada en P1.0. P2.2 implementa el default `'seed'`.

---

## P2.1 — Budget de tokens/coste (gap G; decisión D3 ya hecha en P1.0)
Como P1.0 ya migró a `--mode json`, el `Usage` (tokens + costo USD) viene en el JSON Lines de cada subagente.
- Parsear el `Usage`/`cost` del stdout JSON en `runSubagent` (misma pasada que reconstruye `.output`).
- Exponer en el `ctx` del worker `ctx.budget = { total, spent(), remaining() }` (síncrono): `total` desde
  `workerData` (de `input`/límites; `Infinity` si no se configuró); `spent()` refleja un acumulador que el
  host actualiza por cada agente que retorna (espejo en el worker).
- **Corte duro:** guard en `runSubagent` (estilo `maxAgents`) cuando se supera el budget.
- **Persistencia para resume:** guardar el acumulado (`baseSpent`) en el journal/status y reusarlo al
  reanudar — cortar por `spent` **persistido**, no recomputado, para no divergir.
- **Caveat (documentar):** providers sin precio dan `cost=0` aunque haya tokens reales → tokens fiables,
  `costUsd` best-effort.
- **Guía:** habilitar el patrón `loop-until-budget` (`while (ctx.budget.remaining() > N) {...}`).

**Verificar P2.1:** `ctx.budget.spent()` crece con cada subagente; el corte frena nuevos spawns; resume no
doble-cuenta.

---

## P2.2 — Guardas de determinismo (gap E; decisión D5: default `'seed'`)
- **Capa 1 (aditiva, siempre on):** exponer en el `ctx` del worker `ctx.now()`, `ctx.random()`, `ctx.uuid()`
  sembrados por `sha256(runId)` (`runId` ya está en `workerData`) + tick monotónico sincrónico. En resume,
  reusar el `started`/`startedAt` ORIGINAL como epoch base (ya persistido en status).
- **Capa 2 (default `'seed'`):** opción `determinism: 'off' | 'seed' | 'strict'`. En `'seed'`/`'strict'` inyectar
  un PRELUDE en el sandbox vm que reemplace `Date`/`Date.now`/`Math.random`/`crypto.getRandomValues` por las
  versiones sembradas (`'strict'` además puede avisar/error ante usos no soportados). **Default `'seed'`** =
  determinista por defecto (resume siempre barato). Opt-out `determinism:'off'` restaura los globales reales;
  además exponer `ctx.unsafeNow()/ctx.unsafeRandom()` para wall-clock/azar real puntual.
- **Guía:** documentar `ctx.now()/ctx.random()` como el camino determinista; caveat de que `Date.now()`/
  `Math.random()` en args rompen el cache (re-ejecutan en resume — degradación segura).

**Verificar P2.2:** por default (`'seed'`), dos runs del mismo workflow dan los mismos valores de `now/random`
(resume = cache-hit); con `determinism:'off'` (opt-out), `Date.now`/`Math.random` vuelven a ser reales.

---

## P2.3 — `ctx.workflow(name, args)` sub-workflows (gap H; decisión D6: HOST eval)
- **HOST eval (no anidar Worker):** el host resuelve (`resolveWorkflow`, respetando el trust gate), lee,
  `transformWorkflowCode`, y evalúa el código del sub-workflow en el HOST (`vm.createContext` con sandbox
  nuevo), invocándolo con un **ctx-hijo** que **reusa** el mismo `agentSemaphore`, `agentCount`, `runSignal`,
  `journal`, `occCounters`, `runDir`, `cwd`, `limits` del padre (por closure). Motivo: el semáforo (closures)
  y el journal/`occCounters` (Maps en memoria) **no son serializables** a un Worker; anidar fragmentaría
  `maxAgents` y el cache.
- Agregar `workflow` a `WorkflowRuntimeApi`, al `ctx` del worker (`hostCall("workflow", ...)`) y a
  `allowedMethods`. El handler en el host lanza la evaluación y devuelve el `output` del sub-workflow.
- **Profundidad 1:** el ctx-hijo **no** expone `workflow()` (o lanza si se llama). Mantener un `Set` de
  nombres en curso para cortar ciclos.
- **Cache:** prefijar la `computeCallKey` con un `occNamespace` (nombre del sub-workflow) para no colisionar
  el journal padre/hijo (falso cache-hit).
- `appendEvent({ type:"workflow", name, phase })` para auditabilidad; `ctx.log` al entrar/salir con
  `agentCount` restante (no-silent-caps: el sub-workflow consume `maxAgents` del padre).
- **Guía:** enseñar `ctx.workflow()` (Plano A) + smell test vs secuenciar workflows (Plano B): sin decisión
  entre sub-pasos → A; "leer, luego decidir" → B.

**Verificar P2.3:** un workflow que llama `ctx.workflow("lib/x", args)` corre el hijo compartiendo límites;
A→B→A se rechaza por depth/ciclo; el cache no cruza falsamente padre/hijo.

---

## P2.4 — `isolation:"worktree"` (gap I; decisión D4: `os.tmpdir()`)
- `AgentOptions`: `isolation?: "none" | "worktree"` (default `"none"`), `isolationBase?` (default `"HEAD"`),
  `keepWorktree?: boolean`.
- En `runSubagent`, antes de `pi.exec` y solo si `isolation==="worktree"`: crear el worktree con
  `git worktree add --detach <os.tmpdir()/pi-wf-<runId>/<agentId>> <isolationBase>` y usar ese path como
  `cwd` del subagente. Gate: requiere repo git + `ctx.isProjectTrusted()`.
- **Cleanup:** `git worktree remove --force <path>` best-effort en el `finally` de `runWorkflow` (tras
  `Promise.allSettled(trackedSubagents)`), salvo `keepWorktree`.
- **Trampa única:** excluir `isolation`/`isolationBase`/`keepWorktree` de la cache-key en `sanitizeAgentOpts`
  (el path efímero envenena el resume si entra en la key).
- **Guía:** documentar `isolation:"worktree"` para mutación de archivos en paralelo (refactors/fix fan-out).

**Verificar P2.4:** dos subagentes `isolation:"worktree"` editan el mismo archivo sin pisarse (cada uno en su
worktree); el cache de resume no se rompe por el path efímero; cleanup elimina los worktrees.

---

## Verificación (P2 completa)
1. esbuild tras cada tarea; `tsc --noEmit` con peer deps (ver handoff P0/P1); cero errores nuevos.
2. E2E por tarea (patrón del harness de resume): budget (corte + no doble-conteo en resume), determinismo
   (seed reproducible; off intacto), `ctx.workflow` (límites compartidos + depth-1 + cache namespaced),
   worktree (aislamiento + cleanup + cache estable).
3. Wiring por grep (`ctx.budget`, `determinism`, `workflow` en allowedMethods, `worktree`).

## Orden
Independientes; sugerido **P2.1 → P2.2 → P2.3 → P2.4** (budget primero porque reusa P1.0; las demás en
cualquier orden) → review adversarial → fix → verificación final + `git diff`.

## Cierre
Con P0+P1+P2 la extensión alcanza paridad funcional con los Claude dynamic workflows. Actualizar
`README.md` y `skills/dynamic-workflows/SKILL.md` con la matriz de paridad final y ejemplos por primitiva, y
considerar agregar la librería de scaffolds y el lint pre-run de la sección "Authoring & Composición" del plan.
