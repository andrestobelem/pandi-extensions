# Auditoría del repo — errores e inconsistencias (2026-07-01)

Informe consolidado de una auditoría read-only del monorepo de extensiones
`pandi-dynamic-workflows`, ejecutada con workflows dinámicos multi-agente. Recoge
solo hallazgos con cita concreta `archivo:línea`; los marcados **[verificado]**
fueron re-chequeados a mano contra el archivo, los **[plausible]** quedan
pendientes de verificación fina.

## Método

Tres corridas sucesivas (workflows `.pi/workflows/repo-audit{,-2,-3}.js`), cada
una read-only con `tools: [read, grep, find, ls]` y un juez de síntesis:

- **v1** — 7 reviewers por área + salida con schema estricto + juez opus.
- **v2** — shards chicos por extensión, sin schema estricto (parse tolerante de
  bloque JSON), tope de verbosidad y roster **cross-provider** (anthropic +
  openai-codex), con doble review en las 3 áreas core.
- **v3** — re-corrida dirigida de las áreas que salieron vacías; `index.ts` se
  parte en shards por función (grep + lecturas dirigidas, nunca el archivo
  entero) y los shards vacíos se reintentan una vez con `cache:false`.

Gate determinista en cada corrida: `tsc --noEmit` limpio, `biome check` limpio
(255 archivos), `markdownlint` 0 errores.

## Hallazgos de alto impacto (HIGH)

1. **Los 25 scaffolds no se empaquetan** — `package.json:17`. **[verificado]**
   `files: ["extensions/*/*.ts", …]`: el glob `*/*.ts` matchea un solo nivel y
   solo `.ts`, así que excluye `extensions/pandi-dynamic-workflows/scaffolds/*.js`
   (dos niveles, `.js`). `pattern-scaffolds.ts` los lee de disco en runtime
   (`readdirSync`) y **lanza** si faltan (`throw` en la resolución del patrón);
   su propio comentario afirma que `files[]` los envía. Un paquete publicado a
   npm rompería en cualquier pedido de scaffold. Impacto real solo si se
   distribuye vía npm; nulo si se usa `pi install ./` desde el repo.
   Fix: agregar `extensions/pandi-dynamic-workflows/scaffolds/` (o `**/scaffolds/*.js`)
   a `files`.

2. **`web_search` cargado desde un `cwd` no confiable** —
   `agent-env-persona.ts:294-327`. Resuelve la extensión por defecto en
   `path.join(ctx.cwd, "node_modules", …)` y la agrega a los subagentes **sin**
   `ctx.isProjectTrusted()` (a diferencia de las personas). Un `cwd` malicioso
   puede colocar `node_modules/pi-codex-web-search` y lograr ejecución de código
   en cada subagente. Fix: gatear la búsqueda en `cwd` tras `isProjectTrusted()`.

3. **pi-goal: entradas muertas y sesión muerta** — `pi-goal/index.ts`.
   - `stopGoal` (437-456) nunca hace `activeGoals.delete(goalId)`; pi-loop sí
     (`stopLoop`, línea 795). Los goals terminales se acumulan y cada
     `agent_end`/scan recorre entradas muertas. **[verificado]**
   - `session_shutdown` (839-860) aborta el controller pero no cambia el
     `gstatus` de goals `verifying-independent`; la continuación post-await
     llama `advanceGoal`/`wake` → `sendUserMessage` sobre una sesión ya muerta.

4. **pi-loop: bypass del gate de acciones irreversibles** —
   `pi-loop/index.ts` (`stopLoop`, `inFlightOwnerAlive`, `agent_end`).
   **[plausible]** `stopLoop` borra el loop de `activeLoops` pero no limpia el
   flag module-level `autopilotTurnInFlight`; en la ventana entre idle y
   `agent_end`, un `fireWake` de otro loop puede colar un turno con el gate de
   confirmación bypasseado.

5. **Gate de plan-mode incompleto** — `pi-plan/gate.ts:64`. **[verificado
   parcial]** La regex de mutación git cubre `commit|add|push|reset|…` pero
   **no** `pull`, `clone`, `fetch` → pasan como permitidos en modo plan (rompe
   la garantía read-only; `git pull` muta el working tree). Igual patrón con
   package managers (`npm uninstall|update`, `pnpm remove`, `yarn upgrade`).
   Nota: `git worktree add` **sí** queda atrapado por la palabra `add` (el
   subagente se equivocó al listarlo). Fix: default-deny de subcomandos git/PM
   salvo allowlist read-only.

6. **`agents()` no puentea `signal`** — `worker-source.ts:237`. `race()` promete
   cancelar a todos los perdedores, pero solo `agent()`/`ask()` bridgean
   abort-call; además `agents(items, { signal })` reenvía el `AbortSignal`
   verbatim → `DataCloneError` al serializar en `postMessage`. Fix: wrapper de
   `agents` que borre `signal` y postee abort-call.

7. **Teardown de cancelación en el core** — `index.ts:~533-551`. **[plausible]**
   `cleanup()` dispone los `callControllers` (y sus combined-signals) durante el
   mismo dispatch de `abort`; los listeners aún no invocados se remueven antes de
   dispararse, así que los hijos de subagente no se matan al cancelar y el
   teardown bloquea hasta `agentTimeoutMs`.

8. **Gate de plan-mode process-global** — `pi-plan/index.ts`. El estado del gate
   no está scopeado por sesión (`activePlans` module-level; `session_start` hace
   `clear()`), así que una sesión puede bloquear o limpiar el gate de otra.

## core-dispatch (parte B) — dispatcher, journal, resume (corrida 4, opus)

- **Secretos en disco vía `ask()`** — `index.ts:1418-1437`. **[verificado]** `runAsk`
  escribe la respuesta humana verbatim en `events.jsonl` y `journal.jsonl` sin
  redacción, y la replay-ea en resume (`index.ts:1367`). Si `ask()` se usa para
  recoger un secreto/API key, queda persistido en texto plano. Fix: opción de
  redacción para `ask()` sensible, o no journalizar la respuesta.
- **Colisión de cache key por env** — `agent-env-persona.ts:170-174`.
  **[verificado]** `sanitizeEnvForCache` mapea TODO valor a `"[set]"`, así que dos
  valores distintos de la misma env var producen la misma cache key: en resume se
  replay-ea el resultado journalizado stale en vez de re-ejecutar. Fix: incluir un
  hash del valor (no el valor) en la key.
- **Agujero de journal se re-ejecuta en silencio** — `journal.ts:99-108`. Una
  línea no-final malformada se saltea con solo un `console.warn`; ese slot
  `(key,occ)` queda hueco y en resume la llamada cacheada RE-CORRE (re-gasta
  tokens / repite side effects) sin aparecer en el status. **[low]**
- **`bash()` en rama perdedora de `race()` no se cancela** — `index.ts:593,1279`.
  El dispatcher instala `callSignal` solo para `agent`/`ask`; `bash` cae al else
  y usa `runSignal.signal`, así que un `bash()` de un perdedor corre hasta el
  final y journaliza — inconsistente con `agent`/`ask`. **[low]** (mismo patrón
  que el HIGH 6 de `agents()`).
- **Error de live-write descartado en path de throw** — `index.ts:1032-1037`.
  `liveWriteError` solo se reporta al llegar a `await liveWriteTail`; si
  `runStreamingAgentProcess` lanza antes (timeout/abort), el error de escritura
  del log en vivo se pierde. **[low]**

## devtools-a y docs-consistency (auditado inline — sin hallazgos)

Tras salir vacías repetidamente en los workflows, se auditaron a mano:

- **pi-bg / pi-typescript-lsp**: sin defectos evidentes. `process-liveness.ts`
  maneja con cuidado el reuso de PID (usa `process.kill(pid,0)` solo para
  etiquetar, captura un start-id para distinguir pids reusados); `tsc` se
  spawnea con argv (nunca shell); el único `shell:true` es en `/bg` para el
  comando del propio usuario (by design); el único `ctx.ui.notify` está guardado
  por `if (ctx.hasUI)` (`pi-bg/index.ts:262`).
- **README vs código**: sin drift en el spot-check — env vars coinciden con
  `.env.example` (`MAX_DEPTH=2`, `PERCENT=30`, `SNAPSHOT_KEEP=20`,
  `TS_LSP_MAX=20`) y los 13 comandos slash documentados coinciden con las
  extensiones registradas.

## Medium / Low destacados (verificados en corrida 1)

- **pi-pandi**: ~13 llamadas `ctx.ui.*` sin guard `ctx.hasUI`
  (`pi-pandi/index.ts:143-236`) → posible crash en `--print`/headless; todas las
  extensiones hermanas sí lo checkean.
- **pi-local-memory**: atributo XML `path="${shownPath}"` sin escapar
  (`index.ts:157`); path con `/` hardcodeado en vez de `path.join`
  (`memory.ts:165`, Windows).
- **pi-rename**: `latestEditor` module-level puede repintar el editor de otra
  sesión (`index.ts:38,68`); `slice(-MAX)` conserva la cola pero el slug toma la
  primera línea (`spawn-summary.ts:66`); `borderColor` lookup siempre `undefined`
  (`index.ts:100`, dead code).
- **pi-auto-compact**: `PI_AUTO_COMPACT_CLEAR_MIN_CHARS=0` se rechaza en
  silencio (`index.ts:154-155`).
- **pi-mdview**: footer `1-0/0` para documento vacío (`index.ts:120`).
- **Otros** (corrida 2, deduplicados por el juez): `runProcess` reporta
  `ok:true` tras timeout; `mapLimit` no corta otros workers al primer throw;
  callbacks de streaming fire-and-forget; spawn-antes-de-abort en worktree y
  container (severidad baja: SIGTERM en el mismo tick); "open hint" de worktree
  con path crudo (LOW, es un string mostrado, no ejecutado); varios casts sin
  validar sobre `event.input` en el gate.

## Cobertura y límites

| Área | Estado |
|------|--------|
| context-effort (pi-effort, pi-btw, pi-auto-compact, pi-local-memory) | cubierto |
| ux-aliases (pi-rename, pi-pandi, pi-mdview) | cubierto |
| core-primitives, core-env-resume | cubierto (doble modelo) |
| pi-plan, pi-goal, devtools-b (worktree, container) | cubierto |
| config-manifest | cubierto |
| core-dispatch (parte A: signal/dispatcher/wrap/workflow) | cubierto |
| core-dispatch (parte B: journal/runSubagent/runBash/makeApi/handleTool) | cubierto (corrida 4, opus) |
| devtools-a (pi-typescript-lsp, pi-bg) | cubierto (auditoría inline) |
| docs-consistency (README vs código) | cubierto (auditoría inline) |

Cobertura completa. Las áreas que volvían vacías en los workflows se cerraron
con opus (core-dispatch-b) o con auditoría manual (devtools-a, docs-consistency),
sin hallazgos nuevos en estas dos últimas.

## Lecciones de fiabilidad de los workflows

- **Truncamiento de salida (v1).** Reviewers pesados con schema estricto
  generan hallazgos muy verbosos cuyo JSON excede el presupuesto de tokens y se
  corta a mitad → parse falla → rama descartada. Mitigación: shards chicos, tope
  de verbosidad (`issue`/`evidence` cortos, máx. ~8 hallazgos), parse tolerante.
- **`empty JSON event stream` (v2/v3/v4).** En modo-JSON sobre tareas con mucho
  tool-use, tanto los subagentes **codex** (`gpt-5.5`/`gpt-5.4`) como
  **`claude-sonnet-4-6`** devuelven un mensaje final vacío de forma persistente
  (ni el retry con `cache:false` lo arregla); **`claude-opus-4-8` fue el único
  fiable**. Recomendación: usar opus para shards de salida estructurada tool-heavy,
  o auditar inline las áreas chicas que insistan en salir vacías.
- **`maxAgents` debe contemplar los reintentos.** v3 lanza `N` shards + hasta
  `N` reintentos + 1 síntesis; con `maxAgents` justo, el retry consume el
  presupuesto y la síntesis se bloquea (la corrida "falla" aunque el fan-out ya
  haya escrito los findings). Lanzar con `maxAgents ≥ 2·shards + 1`.
