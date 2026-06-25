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
- Los workflows en background deben despertar al agente al completar o fallar, enviando un follow-up automático para inspeccionar artifacts y continuar la tarea.
- Compaction: se volvió al comportamiento original/default de Pi. `.pi/settings.json` no define `compaction`; Pi usa sus defaults (`reserveTokens: 16384`, `keepRecentTokens: 20000`) salvo configuración global externa.
- Prompts de workflows: usar contratos explícitos basados en patrones agénticos: fan-out independiente, evidencia obligatoria, formato fijo, synthesis-as-judge, crítica adversarial, fallas parciales visibles y seguridad por defecto.
