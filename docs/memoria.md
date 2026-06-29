# Memoria de trabajo

Fecha inicial: 2026-06-25

## Cómo trabajamos

- Hablamos en español, de forma directa y práctica.
- Antes de tocar archivos, inspeccionamos el estado del repo y leemos lo relevante.
- Para tareas no triviales usamos workflows dinámicos con subagentes, límites explícitos y artefactos persistidos.
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
- Pi debe funcionar por defecto en modo ultracode always-on: ante cada tarea sustantiva, evaluar si conviene usar workflow dinámico y proceder normal si la tarea es simple.
- Los workflows se lanzan siempre en background en sesiones persistentes TUI/RPC (`run`, `start` y `resume`); foreground queda solo como fallback en print/json donde no hay sesión viva para sostenerlos.
- Los workflows en background deben despertar al agente al completar o fallar, enviando un follow-up automático para inspeccionar artifacts y continuar la tarea.
- Compaction: se volvió al comportamiento original/default de Pi. `.pi/settings.json` no define `compaction`; Pi usa sus defaults (`reserveTokens: 16384`, `keepRecentTokens: 20000`) salvo configuración global externa.
- Prompts de workflows: usar contratos explícitos basados en patrones agénticos: fan-out independiente, evidencia obligatoria, formato fijo, synthesis-as-judge, crítica adversarial, fallas parciales visibles y seguridad por defecto.
- Los workflows deben ser dinámicos y task-specific: ante una tarea compleja se crea/escribe un workflow nuevo para esa tarea (usando ejemplos solo como referencia), idealmente bajo `generated/<task-slug>` como borrador; se hace scout, se mide la work-list y se elige concurrencia/fan-out según tamaño, coste, riesgo y profundidad pedida; no hardcodear `4` salvo como fallback seguro. Si al usuario le gustó, se ofrece guardarlo/promoverlo a un nombre estable y reusable.
- Karpathy aplicado al proyecto: aprender/construir desde implementaciones pequeñas y legibles; usar IA agresivamente para prototipar, pero en trabajo serio exigir especificación, revisión humana, tests/evals, seguridad y evidencia.
- Commits: incluso cuando el usuario pida "commiteá todo", mantener atomicidad. Si hay cambios heterogéneos, separar por unidad coherente (feat/docs/tests/chore) antes de commitear; no meter lockfile, docs, e2e, helpers y cambios de extensión en un único commit paraguas salvo instrucción explícita.
- Push: después de reescribir/splitear commits locales, no pushear implícitamente si el usuario no lo pidió en ese paso. Confirmar estado y dejar claro qué quedó local vs remoto.
- Autopiloto/workflows: el workflow de mejora continua puede terminar `BLOCKED` aun con verde porque deja revisión/commit al humano; antes de commitear, inspeccionar diff y staged set, no asumir que todo el working tree pertenece al run.

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
