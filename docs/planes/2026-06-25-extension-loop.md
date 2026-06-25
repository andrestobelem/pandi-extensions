> Generado por el workflow `loop-extension-design` (2026-06-25): feasibility del SDK real `@earendil-works/pi-coding-agent` + patrones reusables de `extensions/dynamic-workflows.ts` + síntesis. Nota: 1 de 4 agentes de diseño (scheduling/pacing) falló por el cap de reintentos de structured output; su contenido quedó cubierto por la feasibility (§1) y la síntesis (§2.2/§2.4).

# PLAN: Extensión `/loop` para Pi (auto-pace dinámico + intervalo fijo)

## 1. Veredicto de factibilidad

**Factible y de riesgo técnico bajo.** Todo el cableado existe ya en el SDK de Pi y está probado 1:1 en `extensions/dynamic-workflows.ts` (3490 líneas). Verifiqué cada primitiva contra `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`.

**Qué da el SDK directamente:**
- **Re-disparo / "firing"**: `setTimeout`/`clearTimeout` corren en el proceso Node de la extensión, independiente del ciclo de la sesión (confirmado: dynamic-workflows usa timers; los detalles de wake están en `wakeAgentForWorkflowResult`, líneas 2834-2840).
- **Despertar al agente**: `pi.sendUserMessage(content, { deliverAs?: "steer"|"followUp" })` — `types.d.ts:875-877`. Patrón canónico verificado (líneas 2838-2839): `if (ctx.isIdle()) pi.sendUserMessage(p); else pi.sendUserMessage(p, { deliverAs: "followUp" })`.
- **Estado de actividad**: `ctx.isIdle()` (`types.d.ts:224`); no existe evento `idle`, hay que consultarlo dentro del callback del timer.
- **Tool para el modelo**: `pi.registerTool({ name, label, description, promptSnippet?, promptGuidelines?, parameters: TSchema, executionMode?, execute(id, params, signal, onUpdate, ctx) })` — `types.d.ts:335-366,848`. Schema con TypeBox (`import { Type } from "typebox"`, dynamic-workflows:22). El `execute` recibe `ctx: ExtensionContext`.
- **Comando**: `pi.registerCommand(name, { description, getArgumentCompletions?, handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> })` — `types.d.ts:801-806,850`.
- **Persistencia (no va al LLM)**: `pi.appendEntry<T>(customType, data)` — `types.d.ts:879`; el `CustomEntry` "Does NOT participate in LLM context" (`session-manager.d.ts:62`).
- **Rehidratación**: `ctx.sessionManager.getEntries()` (`session-manager.d.ts:257`, expuesto en `ReadonlySessionManager:136`), filtrando `entry.type === "custom" && entry.customType === "loop-state"`.
- **Ciclo de vida**: `session_start` (reason `startup|reload|new|resume|fork`, `types.d.ts:405-411`), `session_shutdown` (reason `quit|reload|new|resume|fork`, `types.d.ts:447-452`), `agent_end` (`types.d.ts:515-518`), `before_agent_start` (`types.d.ts:499-509`). Registro vía `pi.on(...)` (verificado dynamic-workflows:3479-3489).
- **UX**: `ctx.ui.setStatus(key, text|undefined)` (`types.d.ts:79`), `ctx.ui.setWidget(key, string[]|undefined, { placement })` (`types.d.ts:96`), `ctx.ui.notify(msg, "info"|"warning"|"error")` (`types.d.ts:75`), `ctx.ui.confirm/select/input` (`types.d.ts:69-73`), `ctx.ui.theme.fg(...)` (verificado dynamic-workflows:1376), `ctx.hasUI` (`types.d.ts:214`).
- **Seguridad**: `ctx.isProjectTrusted()` (`types.d.ts:226`), `getAgentDir()`/`CONFIG_DIR_NAME` (importados dynamic-workflows:14-15), gate `pi.on("tool_call", ...) -> ToolCallEventResult { block?, reason? }` (`types.d.ts:843,747-751`; `event.input` mutable).
- **Presupuesto (best-effort)**: `ctx.getContextUsage()` -> `{ tokens, contextWindow, percent }` (`types.d.ts:236,192-198`).

**Qué hay que EMULAR (gaps reales — no hay equivalente nativo):**
1. **No hay `ScheduleWakeup` ni cron/cloud-wakeup.** La primitiva de Claude se invierte: el agente expresa su decisión llamando a una tool que registramos (`loop_schedule`/`loop_stop`), y la **extensión** materializa el disparo con `setTimeout` re-inyectando el prompt. No hay daemon de SO.
2. **No hay scheduling cross-process-restart.** Si el **proceso** de Pi muere (no solo la sesión), el `setTimeout` se pierde; sólo se recupera al re-abrir la sesión vía `session_start` leyendo el estado persistido y re-armando el timer con el delay restante.
3. **Print mode (`ctx.mode === "print"`) no puede loopear** (no sostiene sesión persistente). Soportado: `tui` y `rpc`.
4. **No hay tracking de loop nativo**: el estado se persiste manualmente con `appendEntry` + sidecar JSON.

---

## 2. Arquitectura del loop

### 2.1 Motor (un disparo = una iteración)
Invierte `ScheduleWakeup`. Ciclo por **firing**:
1. El callback de `setTimeout` (en el proceso de la extensión) re-inyecta el **prompt de iteración canónico** con `sendUserMessage` usando el guard idle/streaming.
2. El agente ejecuta UNA pasada de trabajo en un turno normal.
3. Al cerrar el turno, el agente decide explícitamente: `loop_schedule(delaySeconds, reason)` (agenda el próximo, = `ScheduleWakeup`) o `loop_stop(reason)` (termina, = "omitir la llamada"). Hacemos la parada **explícita** porque en Pi no hay forma fiable de capturar "el turno terminó sin agendar".
4. **Red de seguridad** en `agent_end`: si el loop sigue `running`, no hubo `loop_stop`, y no se re-armó timer en este turno → re-armar con la cadencia por defecto del modo (idle 1200-1800s en dinámico; `intervalMs` en fijo) con un `reason` de advertencia. Cubre el caso "el LLM se olvidó de llamar la tool".

### 2.2 Modos
- **Dinámico (auto-pace)**: sin intervalo. `loop_schedule(delaySeconds, reason)`; `delaySeconds` se clampa a `[60,3600]` **dentro de `execute()`** (no se confía en el modelo). La extensión sólo valida/clampa, persiste y arma el `setTimeout`. La **heurística de cadencia** NO va en código: va en `promptGuidelines` de `loop_schedule` y en el prompt de iteración (TTL cache ~5min: <300s para pollear estado externo manteniendo cache caliente; 300-3600s para esperas largas; nunca exactamente 300; idle sin señal 1200-1800s; "pensar QUÉ se espera, no cuánto duermo").
- **Intervalo fijo (cron)**: `/loop <tarea> <intervalo>` (5m, 30s, 1h). La cadencia la fija el usuario; la extensión re-arma `setTimeout` tras cada `agent_end` (preferido sobre `setInterval` para no solapar dos iteraciones). En este modo `loop_schedule` es **no-op informativo**: el agente sólo decide continuar/parar, el periodo lo dueña la extensión. Patrón de timestamp absoluto: `if (now >= nextFireAt) { dispatch; nextFireAt += period }`.
- **Autónomo**: variante de intervalo fijo SIN prompt de usuario; el texto re-inyectado es un sentinel generado por la extensión. Exige `isProjectTrusted()` + `confirm` de arranque.

### 2.3 Prompt de iteración (reinyectado idéntico)
`makeLoopIterationPrompt(loop)` — molde estable (igual filosofía que `makeWorkflowWakePrompt`, dynamic-workflows:2822-2832), con interpolación de: (1) la TAREA literal; (2) `iteration k/max`, tiempo y presupuesto restantes; (3) instrucción de hacer UNA sola iteración; (4) cómo decidir seguir/parar (`loop_schedule`/`loop_stop`); (5) en dinámico, la heurística de cadencia completa; en fijo, "el periodo es fijo, sólo elegí continuar/parar"; (6) el `lastReason` previo para dar continuidad entre ventanas de contexto.

### 2.4 Scheduling
100% `setTimeout` en el proceso de la extensión. `nextFireAt` se guarda como **timestamp absoluto** (no delay) para sobrevivir reinicios. Al rehidratar: si `nextFireAt` ya pasó → disparar un único tick de catch-up (nunca replay de N wakes perdidos); si es futuro → `setTimeout(max(0, nextFireAt - Date.now()))`.

### 2.5 Estado / persistencia (doble capa)
- **Memoria**: `Map<loopId, ActiveLoop>` (calca `activeRuns`, dynamic-workflows:230) con `{ loopId, state, task, prompt, mode, intervalMs?, iteration, startedAt, nextFireAt, timer, controller: AbortController, limits, lastReason }`. Fuente de verdad de "qué timers viven AHORA".
- **Disco** (sobrevive reinicios): `appendEntry("loop-state", snapshot)` en cada transición de estado significativa (no en cada heartbeat, para no inflar el JSONL). Rehidratación last-wins por `loopId` en `session_start`.
- (P1) Sidecar JSON atómico temp+rename (patrón `writeJsonFile`, dynamic-workflows:1485) en `getRunRoot`-style dual-root: `ctx.cwd/.pi/loops/<id>/state.json` si trusted, si no `getAgentDir()/loops/<projectHash>/<id>/state.json`. Cubre crash duro donde el JSONL podría no tener el último append.

### 2.6 Ciclo de vida
- `session_start`: barrer `getEntries()`, reconstruir `LoopState` last-wins; para cada `running`, **chequear el Map en memoria por loopId ANTES de re-armar** (si el proceso siguió vivo entre cambios de sesión los timers siguen corriendo → no duplicar) y re-armar con delay restante.
- `session_shutdown`: `clearTimeout` de todos, `controller.abort`, persistir estado `stale` (recuperable, NO `cancelled`) con `nextFireAt` intacto, limpiar status/widget (calca dynamic-workflows:3484-3489).
- `agent_end`: red de seguridad (2.1 paso 4).

---

## 3. API / UX / Seguridad

### 3.1 Comandos (un solo `registerCommand("loop")` con despacho por subcomando)
- `/loop <tarea> [intervalo]` — arranca. Sin intervalo → dinámico; con intervalo → fijo. Parser: último token que matchee `^\d+(s|m|h)$` es el intervalo, el resto es la tarea. Gate: si `ctx.mode === "print"` → `notify` y rechazar.
- `/loop stop [id]` — `clearTimeout`, estado `stopped`, NO re-inyecta. Sin id y un loop activo → para ese; con varios → `ctx.ui.select`.
- `/loop status [id]` — modo, iteración N/tope, ETA del próximo wake, último `reason`, presupuesto.
- `/loop pause | /loop resume` (P1) — pause conserva estado sin disparar; resume re-arma.
- `getArgumentCompletions` ofrece `stop|status|pause|resume` + ids vivos.

### 3.2 Tool para el modelo (`pi.registerTool`)
- `loop_schedule({ delaySeconds: Type.Number({minimum:60,maximum:3600}), reason: Type.String({minLength:3}) })`, `executionMode: "sequential"`. `execute()` valida que exista loop dinámico activo (si no, `isError`), clampa, persiste, arma `setTimeout`, actualiza status. La heurística de cadencia vive en `promptGuidelines`.
- `loop_stop({ reason: Type.String() })` — termina el loop.
- En modo fijo, `loop_schedule` retorna ok informativo sin tocar el periodo.

### 3.3 Status / UX
- `ctx.ui.setStatus("loop", ...)`: p.ej. `↻ loop it 3/10 · next 5m · poll CI`, coloreado con `ctx.ui.theme.fg("accent"/"dim", ...)` (patrón dynamic-workflows:1376). Pause: `⏸ loop paused`. Fin: `✓ loop done 3 it` y luego clear.
- `ctx.ui.setWidget("loop", [...], { placement: "belowEditor" })` opcional: estado + último `reason`/ETA.
- `ctx.ui.notify` en transiciones (arranque, tope, condición, error). Todo bajo `if (ctx.hasUI)` con fallback en print.

### 3.4 Seguridad (gates)
1. **Topes deterministas** (la extensión es el guardián, no el LLM): `maxIterations` (default 25), `maxWallClockMs`, presupuesto best-effort vía `getContextUsage()`. Chequeados **antes** de re-armar (en `fireWake` y en `execute`).
2. **Confirmación de arranque** (`ctx.ui.confirm`) para loops costosos; **siempre** para modo autónomo.
3. **Trust gate**: autónomo y escritura en `.pi` del proyecto requieren `ctx.isProjectTrusted()`; si no, estado a `getAgentDir()`.
4. **Gate de irreversibles en autopiloto** (P1): `pi.on("tool_call", ...)` → cuando el turno fue disparado por un wake (no por el usuario) y la herramienta es destructiva (rm -rf, push --force, deploy, drop, write fuera de allowlist), retornar `{ block: true, reason }`. Conservador: preferir `confirm` sobre `block` duro si hay UI presente.
5. **No pollear trabajo que el harness ya trackea**: guía en `promptGuidelines`; agendar fallback largo (1200-1800s) en su lugar.

### 3.5 Semántica del `reason`
Obligatorio en `loop_schedule`/`loop_stop`. Una frase de "qué eligió y por qué". Se persiste por wake, se muestra en status/`/loop status`/widget, y se re-inyecta en el siguiente prompt para continuidad entre ventanas de contexto. Si viene vacío → placeholder + advertencia.

---

## 4. SLICE P0 (dinámico, de punta a punta, mínimo usable)

**Archivo nuevo**: `extensions/loop.ts`. Sin dependencias nuevas. Exporta `default function(pi: ExtensionAPI)`.

**Imports** (igual cabecera que dynamic-workflows): `import { Type } from "typebox";` y los tipos `ExtensionAPI, ExtensionContext, ExtensionCommandContext` desde el paquete.

**Alcance P0:** sólo modo dinámico, estado en memoria + persistencia básica con `appendEntry`/`getEntries`, parada por `loop_stop` + `maxIterations` + `/loop stop`, status line, rehidratación en `session_start`, limpieza en `session_shutdown`.

**Estructuras y funciones concretas:**
```
interface LoopState {
  loopId: string; task: string; prompt: string;
  mode: "dynamic"; iteration: number; maxIterations: number;
  startedAt: number; nextFireAt: number | null;
  lastReason?: string; status: "running" | "stopped" | "done";
}
interface ActiveLoop extends LoopState { timer: NodeJS.Timeout | null; controller: AbortController; }

const activeLoops = new Map<string, ActiveLoop>();           // calca activeRuns

function makeLoopIterationPrompt(loop: LoopState): string     // molde estable (cf. makeWorkflowWakePrompt)
function setLoopStatus(ctx, loop)                             // ctx.ui.setStatus("loop", theme.fg(...))
function clearLoopStatus(ctx)                                 // setStatus("loop", undefined)
function persist(pi, loop)                                    // pi.appendEntry("loop-state", snapshotSinTimer)
function fireWake(pi, ctx, loop)                              // guard status==="running"; iteration++; chequear maxIterations; isIdle? sendUserMessage : deliverAs:"followUp"
function scheduleWake(pi, ctx, loop, delaySec, reason)        // clearTimeout; nextFireAt=Date.now()+delaySec*1000; persist; setLoopStatus; setTimeout(()=>fireWake(...))
function startLoop(pi, ctx, task)                             // guard mode!=="print"; crear ActiveLoop; iteration 0; sendUserMessage(prompt) inmediato si idle
function stopLoop(pi, ctx, idOrUndef, reason)                 // clearTimeout; controller.abort; status="stopped"; persist; clearLoopStatus
function rehydrate(ctx)                                       // getEntries() filtrar custom/loop-state, last-wins por loopId; si running y !Map.has(id) → re-armar con max(0,nextFireAt-now)

// Registro:
pi.registerTool({ name:"loop_schedule", label:"Loop Schedule", description, promptSnippet, promptGuidelines:[...heurística cadencia...],
  parameters: Type.Object({ delaySeconds: Type.Number({minimum:60,maximum:3600}), reason: Type.String({minLength:3}) }),
  executionMode:"sequential",
  async execute(_id, p, _sig, _upd, ctx){ /* loop activo? clamp [60,3600]; scheduleWake; ok */ } });
pi.registerTool({ name:"loop_stop", label:"Loop Stop", description,
  parameters: Type.Object({ reason: Type.String() }),
  async execute(_id, p, _sig, _upd, ctx){ stopLoop(...); } });
pi.registerCommand("loop", { description, getArgumentCompletions, handler: async (args, ctx) => { /* "stop"|"status" o startLoop */ } });
pi.on("session_start", async (_e, ctx) => rehydrate(ctx));
pi.on("session_shutdown", async (_e, ctx) => { /* clearTimeout+abort+persist stale+clearLoopStatus para cada loop */ });
pi.on("agent_end", async (_e, ctx) => { /* red de seguridad P0 mínima: si running y no se re-armó este turno → re-armar 1200s con reason de advertencia */ });
```
Con esto un usuario hace `/loop revisá el estado del CI y avisame cuando esté verde`, el agente trabaja una iteración, llama `loop_schedule(120, "polling CI, cache caliente")`, la extensión re-dispara a los 120s, y termina solo con `loop_stop` o al llegar a `maxIterations`. `/loop stop` y `/loop status` funcionan; el loop sobrevive un `/reload` vía rehidratación.

---

## 5. Roadmap P1 / P2

**P1:**
- Modo **intervalo fijo / cron**: parser de intervalo, re-arme en `agent_end`, `loop_schedule` como no-op.
- **Persistencia robusta**: sidecar JSON atómico (temp+rename) además de `appendEntry`; resolución de conflicto por `updatedAt` entre JSONL y sidecar; catch-up de un tick.
- **`/loop pause | resume`** y máquina de estados completa (`running|paused|stopped|done|failed|stale`).
- **Gate de irreversibles** vía `pi.on("tool_call")` con allowlist conservadora.
- **Topes de tiempo/presupuesto** con `getContextUsage()`.
- **Red de seguridad** completa en `agent_end`.

**P2:**
- **Multi-loop** robusto con cola FIFO de disparos (serializar `sendUserMessage` para no competir por el turno).
- **Modo autónomo** (sentinel) con trust + confirm obligatorios.
- **GC** de estados `done/cancelled` viejos (patrón `getRunDirs`).
- **Dashboard/widget** rico (cf. `setWorkflowWidget`).
- **Watchdog** absoluto anti-zombie (deadline duro que fuerza `done`).

---

## 6. Riesgos y decisiones abiertas para el usuario

**Riesgos:**
- **Presupuesto de coste/tokens es best-effort**: sólo `getContextUsage()` (aproximado, puede derivar si cambia el modelo). El tope duro real es iteraciones/tiempo.
- **El timer vive en el proceso, no en la sesión**: si el proceso de Pi muere por completo, sólo se recupera al re-abrir esa sesión (gap "Cannot schedule across process restarts"). No hay background tipo cloud-workflow de Claude.
- **Dependencia de que el LLM llame `loop_schedule`/`loop_stop`**: mitigado por la red de seguridad en `agent_end`, pero requiere watchdog absoluto.
- **`deliverAs:"followUp"` puede interrumpir el flujo conceptual** del usuario aunque no el streaming; la status line debe dejar claro que hay un loop vivo.
- **Clamp mínimo 60s**: no permite polling sub-minuto (límite del SDK).
- **Crecimiento del JSONL** con un entry por transición: persistir sólo en cambios significativos.
- **Colisión de nombre `loop`**: si hay otra extensión con `loop`, Pi sufija `:1`/`:2`.

**Decisiones abiertas (necesito tu input):**
1. **`fork`/`new` session**: ¿el loop migra al nuevo archivo de sesión o queda anclado al `sessionId` original? Propuesta por defecto: NO migrar en `fork` (rama distinta); SÍ continuar en `resume`/`reload`.
2. **Default de `maxIterations`** y si exigir confirmación de arranque siempre o sólo para autónomo/costoso.
3. **Política del gate de irreversibles** (P1): `block` duro vs `confirm` cuando hay UI presente, y la allowlist concreta de comandos/paths.
4. **Scope de persistencia**: ¿estado siempre en `getAgentDir()` o preferir `.pi` del proyecto cuando es trusted?

### Archivos críticos para la implementación
- /Users/andrestobelem/ws/at/pi-dynamic-workflows/extensions/loop.ts (archivo nuevo a crear)
- /Users/andrestobelem/ws/at/pi-dynamic-workflows/extensions/dynamic-workflows.ts (patrones a reusar: `activeRuns` Map+AbortController ~230, `wakeAgentForWorkflowResult`/guard print 2834-2840, `writeJsonFile` 1485, `notify` 1260-1265, status `theme.fg` ~1376, `abortActiveWorkflowRuns` 3014-3022, registro tool/command/lifecycle 3375-3489)
- /Users/andrestobelem/ws/at/pi-dynamic-workflows/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts (contrato: `ExtensionAPI` 816-971, `sendUserMessage` 875-877, `appendEntry` 879, `ToolDefinition` 335-366, `RegisteredCommand` 801-806, eventos `SessionStartEvent`/`SessionShutdownEvent`/`AgentEndEvent` 405-518, `ToolCallEventResult` 747-751, `ContextUsage` 192-198)
- /Users/andrestobelem/ws/at/pi-dynamic-workflows/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts (`getEntries` 257, `CustomEntry` 65-69, `ReadonlySessionManager` 136)