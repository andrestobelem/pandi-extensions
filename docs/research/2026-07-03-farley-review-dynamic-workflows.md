# Revisión Farley (MSE) de Pi Dynamic Workflows — 2026-07-03

Revisión de la extensión `pi-dynamic-workflows` (engine/runtime, primitivas,
catálogo de scaffolds, dashboard/graph) con la lente de Dave Farley (*Modern
Software Engineering*): aprendizaje, TDD como feedback, gestión de complejidad,
estabilidad + throughput. Contract Gate: PROCEED (run `…contract-gate-3abe7ce6`).

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

## Próximos pasos sugeridos (TDD, slice mínimo cada uno)

1. Fix #1 (lock sincrónico de resume) + test de caracterización.
2. Fix #2 (`startedAt` en `getRunDirs`) + test.
3. Fix #6/#7 (dead code + param no-op): borrado quirúrgico + pin del contrato.
4. #8: `action=write` corre `transformWorkflowCode` y devuelve el error temprano.
5. Meta #9/#10: nota en el skill ultracode/scaffolds (budget derivado, prosa
   para unidades grandes, síntesis degradada en vez de fail).

Runs: `2026-07-03T01-36-13-315Z-…farley-2560a7c6` (fallido ×2),
`2026-07-03T02-27-27-539Z-…farley-core-125c92cf` (ok). Reseñas recuperadas:
`.pi/tmp/farley/review-{engine-run,tool-dispatch}.md`.
