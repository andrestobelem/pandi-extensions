# Memoria de trabajo

Fecha inicial: 2026-06-25

## En 30 segundos

Este archivo es la memoria operativa de Pandi en este repositorio: resume cómo trabajamos, qué convenciones seguimos y qué decisiones quedan registradas.
Consultalo antes de empezar una tarea no trivial o cuando necesites retomar contexto sin releer todo el historial.

## Cómo trabajamos

- Hablamos en español, de forma directa y práctica.
- Antes de tocar archivos, inspeccionamos el estado del repo y leemos lo relevante.
- Para tareas no triviales usamos workflows dinámicos: subagentes paralelos o secuenciales, límites explícitos de recursos, y artifacts persistidos como evidencia.
- Todo lo importante se documenta en `docs/`: decisiones, workflows, runs, conversaciones y próximos pasos.
- Preferimos cambios pequeños, verificables y con rutas de archivo claras.
- Validamos lo que se pueda con comandos concretos (`node --check`, tests, lint, typecheck, etc.).
- Si algo queda colgado o `stale`, lo registramos y proponemos una versión más liviana o un plan de corrección.
- Distinguimos hechos, riesgos y suposiciones; no inventamos estado que no esté verificado.
- Dejamos próximos pasos accionables al cierre de cada bloque de trabajo.

## Convenciones del proyecto

- `docs/README.md`: índice general.
- `docs/workflows/`: documentación de workflows y ejecuciones.
- `docs/conversaciones/`: resumen de conversaciones y decisiones.
- `.pi/workflows/`: workflows locales/proyecto para automatizar revisiones o investigación.

## Preferencias actuales

- Guardar en `docs/` todo lo realizado y las conversaciones relevantes.
- Mantener registro del estado de los workflows, incluyendo runs fallidos, `stale` o en background.
- Priorizar continuidad: cada sesión debe poder retomarse leyendo `docs/README.md` y esta memoria.
- Pi debe funcionar por defecto en modo ultracode always-on: ante cada tarea sustantiva, evaluar si conviene usar workflow dinámico; proceder inline si es simple.
- Los workflows se lanzan siempre en background en sesiones persistentes TUI/RPC (`run`, `start`, `resume`). Foreground queda solo como fallback en print/json donde no hay sesión viva.
- Los workflows en background deben despertar al agente al completar o fallar, enviando un follow-up automático para inspeccionar artifacts y continuar.
- Compaction: se volvió al comportamiento original de Pi. `.pi/settings.json` no define `compaction`, por lo que Pi usa sus defaults (`reserveTokens: 16384`, `keepRecentTokens: 20000`) salvo configuración global externa.
- Prompts de workflows: usar contratos explícitos basados en patrones agénticos—fan-out independiente, evidencia obligatoria, formato fijo, synthesis-as-judge, crítica adversarial, fallas parciales visibles y seguridad por defecto.
- Workflows dinámicos y task-specific: para cada tarea compleja se escribe un workflow nuevo (usando ejemplos solo como referencia), idealmente bajo `generated/<task-slug>` como borrador.
  - Hacer scout de la tarea y medir la work-list.
  - Elegir concurrencia/fan-out según tamaño, coste, riesgo y profundidad; no hardcodear `4` salvo como fallback seguro.
  - Si al usuario le gustó, ofrecer guardarlo/promoverlo a un nombre estable y reusable.
- Karpathy en el proyecto: aprender/construir desde implementaciones pequeñas y legibles; usar IA agresivamente para prototipar, pero en trabajo serio exigir especificación, revisión humana, tests/evals, seguridad y evidencia.
- Commits: mantener atomicidad incluso si el usuario pide "commiteá todo". Separar cambios heterogéneos por unidad coherente (feat/docs/tests/chore) antes de commitear; nunca mezclar lockfile, docs, e2e, helpers y cambios de extensión en un único commit paraguas salvo instrucción explícita.
- Push: después de reescribir/splitear commits locales, no pushear implícitamente sin confirmación del usuario. Reportar qué quedó local vs remoto.
- Autopiloto/workflows: el workflow de mejora continua puede terminar `BLOCKED` aun con verde porque deja revisión/commit al humano. Antes de commitear, inspecciona diff y staged set; no asumas que todo el working tree pertenece al run.

## Registro 2026-06-25

- Se agregó `npm test` como typecheck de las extensiones publicadas (`dynamic-workflows`, `loop`, `goal`) y pasó localmente.
- Se smokeó `dynamic_workflow` creando un workflow generado de prueba; `action=run` completó con `parallel` (incluyendo rama fallida → `null`), `pipeline`, `bash` y artifact `smoke-result.json`.
- Se smokeó `action=start` en sesión persistente/RPC para el mismo workflow; el run background completó y `action=view` mostró `Background: yes`, timeline y artifacts.
- Se actualizó `extensions/dynamic-workflows.ts` para que en sesiones TUI/RPC los workflows lanzados con `run`, `start` o `resume` vayan siempre en background; `run` foreground queda solo como fallback print/json.
- Se recuperó `.pi/workflows/karpathy-programming-recommendations-research.js` desde git y se integró la síntesis en `docs/research/2026-06-25-karpathy-programming-recommendations.md`.

## Registro 2026-06-26

- Se implementó `/bg` M2a como runner local slash-only: `/bg start`, `/bg cancel`, `/bg list`, `/bg status`, `/bg logs`, con start solo en proyectos trusted/TUI-RPC, bloqueo en `/plan`, artifacts atómicos bajo `.pi/bg/runs/<jobId>/`, logs bounded y cancelación solo de jobs activos de la sesión.
- Se agregó `tests/bg/integration/bg-jobs.test.mjs` para start/completion/failure/cancel/stale/mode gates y se incluyó en `scripts/test/run-all.mjs`.
- La auditoría `generated/bg-m2a-final-audit` completó con síntesis ruidosa; se tomaron los findings de reviewers como accionables y se corrigieron symlink roots, race fast-exit→running, preservación de whitespace en comandos, cancelación Windows vía `taskkill`, y determinismo de tests de integración con `esbuild` devDependency. `npm test` quedó verde.
- Se mantienen diferidos para planes separados: runner Supacode, tool LLM `background_job`, daemon/rehydrate automático, prune/delete y dashboard `/bg`.
