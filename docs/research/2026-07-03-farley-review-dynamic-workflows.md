# Revisión Farley (MSE) de Pi Dynamic Workflows — 2026-07-03

Revisión técnica de la extensión `pandi-dynamic-workflows` (engine/runtime,
primitivas, catálogo de scaffolds, dashboard/graph) con la lente de Dave
Farley (*Modern Software Engineering*): aprendizaje, TDD como feedback,
gestión de complejidad, estabilidad + throughput. Contract Gate: PROCEED (run
`…contract-gate-3abe7ce6`).

## En 30 segundos

Este informe resume qué encontró la revisión técnica, qué defectos reales ya
salieron del proceso y cuáles seguían abiertos en el momento del análisis. Sirve
para ubicar rápido los riesgos más importantes de `pandi-dynamic-workflows` y
ver qué gaps de pruebas siguen pidiendo una corrección concreta.

## Cómo se produjo (y qué encontró el proceso mismo)

Dos workflows: `revisar-dw-farley` (16 reviewers + jurado adversarial 3×N +
síntesis; **falló dos veces por diseño**: fan-out impredecible del jurado vs
`maxAgents`, y schema estricto sobre unidades enormes) y
`revisar-dw-farley-core` (5 reviewers en prosa + síntesis; **completó**). El
proceso en sí encontró y ya corrigió dos defectos del runtime:

- **Bug real (arreglado, `9fb6b50`):** un mensaje final tool-only del subagente
  extraía `""` y **pisaba todo el output real** → `ok:true, output:""` (pérdida
  silenciosa, dos reseñas de 8 min "vacías" recuperadas después del stream crudo).
- **Feature (enviada, `a501094`):** progreso auto-derivado del batch
  (`Review 5/16`) en status line y panel — antes `done/started` mentía por omisión.

## Evaluación general

El kernel está deliberadamente diseñado (abort plumbing documentado, escrituras
atómicas, journal content-addressed, reselect-by-key). El cluster de riesgo real
es **fallo silencioso / restauración de estado bajo concurrencia**: caminos donde
el sistema hace lo incorrecto sin ruido (resume duplicado, `latest` equivocado,
foco que se resetea, errores tragados). Las tres unidades sintetizadas reportan
**cero cobertura de caracterización en los caminos riesgosos encontrados** — el
gap de TDD es exactamente donde están los defectos.

## Hallazgos priorizados (verificados por cita)

### Alta

1. **Resume duplicado concurrente puede corromper un run-dir** —
   `run-lifecycle.ts:220` (guard) vs `:142` (`activeRuns.set` recién dentro de
   `startWorkflowBackground`, con `await`s entre medio). Dos resumes pasan el
   guard y corren contra el mismo journal. *Fix:* placeholder sincrónico en
   `activeRuns` inmediatamente tras el check. *Test faltante:* dos
   `resumeWorkflow` sin await del primero → el segundo debe serializar o tirar.
2. **`latest` resuelve por mtime, no por `startedAt`** — `run-store.ts:29-42`
   ordena `mtimeMs`; `run-state.ts:132-135` (cleanup) ordena `startedAt`.
   Cualquier rewrite de `status.json` en un run viejo lo hace "latest" para
   resume/view/cancel/delete. *Fix:* ordenar por `startedAt` del record.
3. **El foco del Monitor se resetea en cada reopen** —
   `workflow-dashboard.ts:72-80`: `DashboardSelection` persiste
   `monitorAgentIndex` pero no `monitorRunIndex`, anulando el mecanismo de
   restore que documenta.

### Media

4. **`agents()` fail-fast deja hermanos huérfanos** —
   `concurrency-primitives.ts`: al primer throw, los worker-loops hermanos siguen
   spawneando subagentes cuyo trabajo se descarta (queman presupuesto).
5. **`race()` descarta errores reales como "empty"** — `worker-source.ts`: un
   bug genuino de un thunk es indistinguible de "todas las branches declinaron".
6. **`/ultracode` registrado dos veces** — `index.ts:1842` y `:1850`; el primer
   handler es inalcanzable (código muerto). *Verificado.*
7. **Param `background` del tool es no-op** — anunciado en el schema
   (`index.ts:326` área), pero `params.background` no se consume en el dispatch.
   *Verificado.* Confunde al modelo que usa el tool.
8. **`action=write` no valida el código** — no corre `transformWorkflowCode`
   antes de persistir; el código inválido round-tripea OK y falla recién en
   `run/start` (feedback tardío — anti-Farley).

### Diseño del propio catálogo (meta)

9. **Fan-out impredecible en drafts tipo jurado** (3×N hallazgos): el total de
   agentes depende del resultado → `maxAgents` revienta al final y se **skipea la
   síntesis** (el entregable). Regla: derivar el budget del work-list o acotar el
   jurado; degradar (sintetizar lo que hay) en vez de fallar.
10. **Schema estricto sobre unidades grandes** produce `schema:bad`/timeouts;
    la salida en prosa + síntesis-judge es más robusta (lección ya aplicada a las
    lentes del scaffold, ahora también a unidades).

## Cobertura (honesta)

- **Sintetizado:** dashboard-tui, run-resume-state, concurrency-spawn (core run);
  engine-run y tool-dispatch (reseñas recuperadas del stream, citas spot-checked).
- **Revisado pero sin síntesis final:** parsing, graph, unidades livianas y
  14/23 hallazgos que sobrevivieron el jurado del run grande (artefactos en
  `…revisar-dw-farley-2560a7c6/agents/`), lentes security/concurrency/errors
  (fallaron por schema/timeout).
- **No cubierto:** catálogo de 25 scaffolds a nivel por-archivo (muestreo del run
  grande sin síntesis).

## Estado (loop-until-dry 2026-07-03, misma sesión)

| # | Hallazgo | Estado |
|---|---|---|
| 1 | Race de resume duplicado | ✅ `e218115` + `resume-duplicate-race.test.mjs` |
| 2 | `latest` por mtime | ✅ `715a2e1` + `run-latest-by-started-at.test.mjs` |
| 3 | Foco del Monitor se resetea | ✅ `2db52f9` + `dashboard-monitor-focus-restore.test.mjs` |
| 4 | `agents()` fail-fast huérfanos | ✅ `6168a79` + `agents-failfast-cancels-siblings.test.mjs` (el seam ya existía: `PI_DYNAMIC_WORKFLOWS_PI_COMMAND`) |
| 5 | `race()` traga errores | ✅ `e316186` + `race-surfaces-errors.test.mjs` (campo aditivo `errors[]`) |
| 6 | `/ultracode` duplicado | ✅ `5348f3e` + `command-registration-unique.test.mjs` |
| 7 | Param `background` no-op | ❌ descartado: by-design (el schema lo documenta como flag de compatibilidad) |
| 8 | `write` no valida | ✅ `92d3e40` + `write-validates-code.test.mjs` |
| 9/10 | Meta jurado/schema | ✅ `c59da95` (notas en el skill ultracode + mirrors) |

Bonus de la misma revisión: output tool-only pisaba la respuesta (`9fb6b50`),
progreso auto-derivado `Review 5/16` (`a501094`), y **resume ignoraba los
límites explícitos** — hallazgo en vivo, `a7db180` +
`resume-honors-limit-params.test.mjs`.

### Cierre de #4 (mismo día)

El seam "faltante" ya existía: `PI_DYNAMIC_WORKFLOWS_PI_COMMAND` fakea el binario
de subagentes end-to-end (patrón de `race-cancellation.test.mjs`). El Red mostró
el bug completo — hermanos in-flight corriendo a término Y workers ociosos
tomando items NUEVOS tras el fallo — y además aclaró la semántica: un subagente
que sale ≠0 RESUELVE con `ok:false`; el rechazo fail-fast viene de throws reales
(schema `throw`, presupuesto `maxAgents`, abort). Fix: `mapLimit` estructurado
(el primer rechazo aborta una señal scoped, ningún item encolado arranca, el
error original se relanza tras el wind-down) + el fan-out de `agents()` corre
cada item bajo esa señal vía `callSignal`. El `parallel`/`pipeline` del worker
son settling (nunca rechazan), así que no comparten el bug.

Con esto, los 10 hallazgos materiales de la revisión quedan cerrados.

Runs: `2026-07-03T01-36-13-315Z-…farley-2560a7c6` (fallido ×2),
`2026-07-03T02-27-27-539Z-…farley-core-125c92cf` (ok). Reseñas recuperadas:
`.pi/tmp/farley/review-{engine-run,tool-dispatch}.md`.
