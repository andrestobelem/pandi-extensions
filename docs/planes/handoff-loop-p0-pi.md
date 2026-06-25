# Handoff a Pi — Implementar P0 de la extensión `/loop`

Brief para que Pi implemente el **P0** de una extensión tipo `/loop` de Claude (correr una tarea
iterativamente, auto-marcándose el ritmo). Plan completo y fundamento:
`docs/planes/2026-06-25-extension-loop.md` (leerlo). Contrato del SDK:
`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` y `…/session-manager.d.ts`.
Patrones a reusar: `extensions/dynamic-workflows.ts`.

**Archivo nuevo:** `extensions/loop.ts` (export `default function(pi: ExtensionAPI)`). Registrarlo en
`package.json` → `pi.extensions` (junto a `./extensions/dynamic-workflows.ts`) para que cargue.

## Idea central (cómo se traduce el /loop de Claude a Pi)
Pi **no tiene** `ScheduleWakeup`/cron. Se **invierte**: el agente decide llamando a una **tool que
registramos**, y la **extensión** materializa el disparo con `setTimeout` re-inyectando el prompt vía
`pi.sendUserMessage` (guard idle/streaming). El loop vive en el proceso de la extensión.

## Alcance P0 (solo modo dinámico)
Comandos `/loop <tarea>`, `/loop stop [id]`, `/loop status [id]`; tools `loop_schedule(delaySeconds, reason)`
y `loop_stop(reason)`; motor de iteración con auto-wake; parada por `maxIterations` (default **25**) +
`loop_stop` + `/loop stop`; estado en memoria + persistencia con `pi.appendEntry`/`getEntries`
(sobrevive `/reload`); rehidratación en `session_start`; limpieza en `session_shutdown`; red de seguridad
mínima en `agent_end`; status line. **Fuera de P0:** intervalo fijo/cron, modo autónomo, sidecar JSON
atómico, pause/resume, gate de irreversibles, multi-loop con cola (son P1/P2 — ver §5 del plan).

## Reglas duras
- **Gate print:** si `ctx.mode === "print"` → `ctx.ui.notify` y rechazar (no puede loopear; requiere TUI/RPC).
- `delaySeconds` se **clampa a `[60,3600]` dentro de `execute()`** (no confiar en el modelo).
- La **heurística de cadencia** va en `promptGuidelines` de `loop_schedule`, **no** en código.
- No agregar dependencias (`typebox` ya está).
- Defaults decididos: `maxIterations` 25; en sesión `fork` **no** migrar el loop (sí continuar en
  `resume`/`reload`). Persistencia P0: `pi.appendEntry` (el sidecar atómico es P1).

## Primitivas del SDK (confirmar con grep/lectura)
- `pi.registerCommand(name, { description, getArgumentCompletions?, handler:(args,ctx)=>Promise<void> })`.
- `pi.registerTool({ name, label, description, promptSnippet?, promptGuidelines?, parameters: TSchema,
  executionMode?, execute(id, params, signal, onUpdate, ctx) })` (`import { Type } from "typebox"`).
- `pi.sendUserMessage(content, { deliverAs?: "steer"|"followUp" })`. **Patrón de wake** (cf.
  `wakeAgentForWorkflowResult` en dynamic-workflows): `if (ctx.isIdle()) pi.sendUserMessage(p); else
  pi.sendUserMessage(p, { deliverAs: "followUp" })`.
- `pi.appendEntry("loop-state", snapshot)` (no va al LLM). Rehidratar:
  `ctx.sessionManager.getEntries()` → filtrar `type==="custom" && customType==="loop-state"`, last-wins por `loopId`.
- `pi.on("session_start" | "session_shutdown" | "agent_end", handler)`.
- `ctx`: `isIdle()`, `hasUI`, `mode`, `isProjectTrusted()`, `ui.setStatus(key, text|undefined)`,
  `ui.notify(msg, "info"|"warning"|"error")`, `ui.select(...)`, `ui.theme.fg(color, text)`.
- `setTimeout`/`clearTimeout` (proceso de la extensión).

## Estructuras y funciones (de §4 del plan)
```ts
interface LoopState {
  loopId: string; task: string; prompt: string; mode: "dynamic";
  iteration: number; maxIterations: number;
  startedAt: number; nextFireAt: number | null;
  lastReason?: string; status: "running" | "stopped" | "done";
}
interface ActiveLoop extends LoopState { timer: NodeJS.Timeout | null; controller: AbortController; }
const activeLoops = new Map<string, ActiveLoop>();   // calca activeRuns de dynamic-workflows
```
- `makeLoopIterationPrompt(loop)` — molde estable (cf. `makeWorkflowWakePrompt`): tarea literal +
  `iteration k/max` + "hacé UNA iteración" + cómo decidir seguir/parar (`loop_schedule`/`loop_stop`) + la
  heurística de cadencia + el `lastReason` previo (continuidad entre ventanas de contexto).
- `persist(pi, loop)` — `pi.appendEntry("loop-state", { …LoopState sin timer/controller })`.
- `setLoopStatus(ctx, loop)` / `clearLoopStatus(ctx)` — `ctx.ui.setStatus("loop", …)` con `theme.fg`.
- `fireWake(pi, ctx, loop)` — guard `status==="running"`; si `iteration >= maxIterations` → `stopLoop(done)`
  + `notify`; si no, `iteration++`; `persist`; `setLoopStatus`; wake (idle? `sendUserMessage` : `followUp`).
- `scheduleWake(pi, ctx, loop, delaySec, reason)` — `clearTimeout`; `nextFireAt = Date.now()+delaySec*1000`;
  `lastReason=reason`; `persist`; `setLoopStatus`; `timer = setTimeout(()=>fireWake(...), delaySec*1000)`.
- `startLoop(pi, ctx, task)` — guard print; crear `ActiveLoop` (loopId aleatorio, iteration 0, status
  running, maxIterations 25); `activeLoops.set`; `persist`; `setLoopStatus`; enviar el primer prompt ya
  (idle? send : followUp).
- `stopLoop(pi, ctx, idOrUndef, reason)` — resolver loop (id / único activo / `ui.select`); `clearTimeout`;
  `controller.abort`; `status="stopped"`; `persist`; `clearLoopStatus` si no quedan; `notify`.
- `rehydrate(ctx)` — `getEntries()` → loop-state last-wins; por cada `running`: si `activeLoops.has(id)`
  saltar (timer vivo); si no, re-armar `setTimeout(max(0, nextFireAt - Date.now()))` → un **único** tick de
  catch-up (no replay de N wakes perdidos).

**Registro:**
- `loop_schedule`: `parameters: Type.Object({ delaySeconds: Type.Number({minimum:60,maximum:3600}),
  reason: Type.String({minLength:3}) })`, `executionMode:"sequential"`. `execute()`: buscar loop dinámico
  activo (si no hay → `isError`); clampar; `scheduleWake`; ok. `promptGuidelines` = la heurística de cadencia
  (TTL cache ~5min: <300s para pollear estado externo; 300-3600s para esperas largas; nunca exactamente 300;
  idle sin señal 1200-1800s; "pensá QUÉ esperás, no cuánto dormís"; no pollear trabajo ya trackeado).
- `loop_stop`: `parameters: Type.Object({ reason: Type.String() })` → `stopLoop`.
- `pi.registerCommand("loop", { description, getArgumentCompletions, handler })`: si el primer token es
  `stop`/`status` → despachar; si no, toda la `args` es la tarea → `startLoop`. Completions: `["stop","status"]`
  + ids vivos.
- `pi.on("session_start", (_e, ctx) => rehydrate(ctx))`.
- `pi.on("session_shutdown", …)`: por cada loop → `clearTimeout`, `controller.abort`, `persist` con status
  **`stale`** (recuperable, conservar `nextFireAt`), `clearLoopStatus`.
- `pi.on("agent_end", …)`: red de seguridad — si un loop sigue `running` y no se re-armó timer en este turno
  (ni hubo `loop_stop`) → `scheduleWake(1500, "auto: el turno cerró sin loop_schedule")`.

## Verificación
1. **Sintaxis:** `npx --yes esbuild extensions/loop.ts --bundle=false --outfile=/dev/null`.
2. **Tipos:** con las peer deps instaladas (`npm install --no-save @earendil-works/pi-coding-agent@0.80.2
   @earendil-works/pi-ai@0.80.2 @earendil-works/pi-tui@0.80.2 typebox typescript @types/node`) →
   `npx tsc --noEmit` con tsconfig mínimo (`module ESNext`, `moduleResolution Bundler`, `strict`,
   `skipLibCheck`, `types:["node"]`). Cero errores en el código nuevo.
3. **E2E (sin esperar 60s reales):** mock `pi` (capturar `sendUserMessage`, `appendEntry`→array, registrar
   tool/command/on) y `ctx` (`isIdle` toggle, `mode:"tui"`, `hasUI:false`, `sessionManager.getEntries`→array,
   `ui.setStatus` no-op). Probá llamando a las funciones directamente (no por wall-clock): `startLoop` envía
   el primer prompt; `loop_schedule.execute` clampa y arma timer (stubear `setTimeout` o invocar `fireWake`
   directo); `fireWake` re-inyecta y respeta `maxIterations`; `loop_stop`/`/loop stop` paran; `rehydrate`
   re-arma desde los entries persistidos; `ctx.mode:"print"` se rechaza.
4. **Wiring por grep:** `loop_schedule`/`loop_stop`/`registerCommand("loop")`/`appendEntry`/`session_start`.

## Orden
estructuras + `persist` → `startLoop`/`fireWake`/`scheduleWake` → tools → command → lifecycle
(`session_start`/`session_shutdown`/`agent_end`) → status line → verificación → review adversarial
(lentes: doble-disparo en rehidratación, propagación de `abort`/clearTimeout, clamp/guards de `execute`,
print gate, no replay de wakes perdidos) → fix → `git diff`.

## Después de P0
P1 (intervalo fijo/cron, sidecar atómico, pause/resume, gate de irreversibles, topes de tiempo/presupuesto) y
P2 (multi-loop con cola, autónomo, GC, watchdog) según §5 del plan. Decisiones abiertas restantes (§6):
política del gate de irreversibles y scope de persistencia robusta.
