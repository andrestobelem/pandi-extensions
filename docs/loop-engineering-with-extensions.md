# Ingeniería de loops con nuestras extensiones

Fecha: 2026-06-28

Un loop de agente que nunca termina quema dinero; uno que se da por "done" por
cuenta propia suele equivocarse (un modelo que juzga su propio trabajo es
poco confiable — Huang et al., arXiv:2310.01798). Este repositorio trae dos
extensiones para cubrir ese problema: **`/goal`** avanza hacia un objetivo hasta
que una verificación *independiente* lo confirma, y **`/loop`** repite una tarea
en una cadencia acotada sin ninguna noción de "finished". Usá `/goal` cuando
podés escribir un criterio de éxito verificable; usá `/loop` para trabajo de
monitoreo o polling sin estado final claro.

## En 30 segundos

```bash
/goal migrate tests to vitest -- all tests pass; no jest imports remain
/loop watch the deploy and report when it stabilizes
```

Esta guía convierte la
[investigación sobre loop engineering](./research/2026-06-28-loop-engineering.md)
en uso concreto: la investigación explica *qué* es loop engineering y *por qué*
funcionan los mecanismos del repo; esta guía explica *qué extensión elegir* y
*cómo operarla*.

> **Definición (de la investigación).** *Loop engineering* es la disciplina de
> **diseñar, acotar y verificar** loops iterativos/de feedback para que un loop
> haga progreso medible hacia una meta y **se detenga por evidencia** (`done` /
> `quiet` / `blocked`) en lugar de hacerlo por un timer, por auto-declaración o
> nunca. La versión corta: acotá el loop **y** mantené la señal de crítica
> independiente y no sesgada — `/goal` es la superficie que impone ambas cosas a
> la vez.

## TL;DR — elegí la superficie de loop correcta

| Superficie | Pregunta que responde | Usala cuando | Principio que encarna |
| --- | --- | --- | --- |
| `/goal` | *¿En qué estado estoy?* | El trabajo tiene un `done` verificable | Verificación independiente (la más fuerte) |
| `/loop` | *¿Cuándo me despierto?* | Tareas recurrentes sin estado de fin | Cadencia acotada, no confiar en el modelo |
| `loop-until-dry` workflow | *¿Ya convergió?* | Búsquedas exhaustivas que necesitan converger | Convergencia por rondas quietas |
| `/effort ultracode` + Contract Gate | *¿Qué significa "done"?* | Tareas de orquestación vagas o amplias | Acotar y verificar el alcance primero |

## Las cuatro superficies de loop

### `/goal` — loop cerrado con verificación independiente

Usá `/goal` siempre que exista una definición concreta y verificable de terminado.
Ejecuta `pursuing → verifying → verifying-independent → done | blocked`: primero
una comprobación de completitud, después un **subagente adversarial separado y
solo de lectura** que emite `VERDICT: PASS | FAIL`. Solo un `PASS` independiente
cierra el goal (`beginIndependentVerification` en
`extensions/pandi-goal/verification.ts`). Esta es la respuesta arquitectónica
directa del repo al resultado de que la autocorrección no es confiable.

```bash
# Objetivo -- criterios de éxito después de `--`
/goal migrate tests to vitest -- all tests pass; no jest imports remain
/goal status
/goal stop
```

Guardrails que heredás gratis:

- Nunca hay loop infinito; `fireGoal` aplica el guard
  `goal.iteration >= goal.maxIterations` en
  `extensions/pandi-goal/scheduler.ts`.
- Una afirmación sin evidencia verificable es `FAIL`; `runIndependentVerifier`
  fija ese contrato en `extensions/pandi-goal/verifier.ts`.
- Guard contra oscilación: `beginIndependentVerification` compara
  `independentVerifyAttempts` con `maxIndependentVerifications` (por defecto 2)
  y pasa el goal a `blocked` en vez de dejarlo girando para siempre
  (`extensions/pandi-goal/verification.ts`).

### `/loop` — cadencia acotada, no confiar en el modelo

Usá `/loop` para trabajo recurrente que no tiene un `done` binario: monitoreo,
polling, autopilot. El modelo propone un delay de wake; la extensión **lo satura**
a una banda segura de `[60, 3600]s` para que un valor malo nunca desestabilice
el loop (`MIN_DELAY_SECONDS` / `MAX_DELAY_SECONDS` en
`extensions/pandi-loop/constants.ts`; `clampLoopDelaySeconds` en
`extensions/pandi-loop/loop-tools.ts`).

```bash
# Cadencia fija (el último token es el intervalo)
/loop check whether CI went green 10m

# Cadencia dinámica (el modelo elige el delay; se limita)
/loop watch the deploy and report when it stabilizes

# Loop autónomo confiado (requiere /trust primero)
/loop auto keep the docs index in sync with docs/ 1h

/loop status   /loop pause   /loop resume   /loop stop
```

Elegí la cadencia con intención:

- Poll corto (`< 300s`, nunca exactamente 300) para estado externo rápido (CI,
  deploy) manteniendo cache caliente.
- Fallback largo (`1200–1800s`) cuando está idle y no hay señal concreta.
- No consultes trabajo que el harness ya rastrea (subagentes, workflows) — usá un
  fallback largo y dejá que reporte de vuelta.

Defense in depth: `capExceeded` y `preWakeLimit` en
`extensions/pandi-loop/caps.ts` combinan wall-clock, context-budget de mejor
esfuerzo, iteraciones y watchdog; `fireWake` en
`extensions/pandi-loop/scheduler.ts` aplica ese resultado antes de entregar un
wake. Ojo: el tope de context-budget es un **soft sensor** — hace no-op
silencioso cuando el uso se ignora, así que no dependas solo de él.

### `loop-until-dry` — convergencia por rondas quietas

Cuando el objetivo es exhaustividad y no un solo `done` (auditorías, búsquedas
a nivel repo), usá el scaffold `loop-until-dry`. Ejecuta finders en paralelo en
cada ronda y se detiene cuando **no aparecen hallazgos nuevos durante
`quietRounds` rondas consecutivas**: un detector de settle-to-tolerance, no un
flip de quietud transitoria.

```bash
/workflow run loop-until-dry {"target":"all places we parse SSE chunks","quietRounds":2,"maxRounds":8}
```

- `quietRounds` (por defecto 2) es un debounce/deadband, no un punto fijo
  probado.
- `maxRounds` (por defecto 8) es el freno duro; cuando se detiene ahí, lo dice
  en voz alta con `stopped at maxRounds (not dry)` en
  `extensions/pandi-dynamic-workflows/scaffolds/loop-until-dry.js` — no hay
  topes silenciosos.

### Ultracode + Contract Gate — acotar primero el alcance

Antes de orquestar trabajo amplio o a nivel repo, dejá que el Contract Gate
precise qué significa "done". Corre una revisión pequeña y de solo lectura del
contrato de tarea y emite `improvedTask`, `successCriteria`, `assumptions`,
`nonGoals`, `routingHints`, `verificationPlan` y `blockers` — así el loop
optimiza contra un objetivo acordado en vez de contra un prompt vago.

```bash
/effort ultracode          # request xhigh + enable always-on routing
/ultracode-contract off    # disable the Contract Gate for this session
/ultracode-mode off        # turn the router off (lowering effort does not)
```

## Los ocho principios → perillas que controlás

| Principio | Qué significa en la práctica | Dónde se configura |
| --- | --- | --- |
| Terminación acotada | Nunca dejes que un task con meta loopée para siempre | Usá `/goal` en vez de `/loop` |
| Topes en capas | Wall-clock + iteraciones + budget | Defaults de `/loop`; `maxRounds` en workflows |
| Clamp de cadencia | El delay del modelo se satura, no se confía | `/loop` limita a `[60, 3600]s` |
| Convergencia | Cortar cuando los hallazgos se mantienen cerca de 0 | `quietRounds` en `loop-until-dry` |
| Reanudación | Rehidratar sin una avalancha de catch-up | `dynamic_workflow action=resume` |
| Gate de acciones destructivas | Gatear acciones riesgosas solo en autopilot | `/loop auto` después de `/trust` |
| Verificación independiente | Cerrar por una señal externa, no por autoafirmación | Verificador independiente de `/goal` |
| Sin topes silenciosos | Si se corta por budget, hay que reportarlo | Mantener el log "stopped at maxRounds" |

## Recetas

Ejecutá trabajos distintos en paralelo (no se componen — ver abajo):

```bash
/goal implement feature X -- criteria ...   # itera hasta quedar verificado
/loop watch the X deploy 5m                 # repite en una cadencia
```

Manejá cada uno por separado — mantienen estado e IDs distintos:

```bash
/goal status     /goal stop [id]
/loop status     /loop pause [id]   /loop resume [id]   /loop stop [id]
```

## Anti-patrones

- **No** uses `/loop` en una tarea que tenga un `done` verificable; para eso es
  `/goal`. `/loop` no tiene noción de "finished".
- **No** manejes la *misma* tarea con `/goal` y `/loop` esperando que el goal le
  fije la cadencia al loop. Son extensiones independientes, con estado separado,
  y **no** se componen; solo `ctx.isIdle()` evita que inyecten en un turno en
  vuelo. Elegí una sola superficie por tarea.
- **No** confíes en el context-budget cap como garantía dura: es best-effort y
  puede hacer no-op silencioso.
- **No** reportes `done` cuando un loop apenas llegó a su cap. Mostrá el cap.

## Procedencia y fuentes

Esta guía operacionaliza la investigación con fuentes de respaldo en
[`docs/research/2026-06-28-loop-engineering.md`](./research/2026-06-28-loop-engineering.md),
que contiene las citas externas (ReAct, Reflexion, Self-Refine, Huang et al.,
teoría de control/feedback) y el grounding verificado `file:line` para cada
mecanismo mencionado arriba. Ver también el
[mapa más amplio de patrones agentic](./research/2026-06-25-agentic-patterns-papers-workflows.md).
El comentario de cabecera en `extensions/pandi-goal/index.ts` también documenta
directamente en código la distinción `/loop` vs `/goal`.
