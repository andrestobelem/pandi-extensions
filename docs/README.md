# Documentación del proyecto

Esta carpeta reúne el historial de trabajo del proyecto, sus decisiones, los workflows creados y las conversaciones relevantes. Es una referencia duradera y un rastro de auditoría al que siempre podés volver. 🐼

## En 30 segundos

Si querés ubicarte rápido, empezá por la guía de `Setup`, la documentación de `Dynamic Workflows` o los `Handbooks`. Si buscás contexto histórico o decisiones, entrá en `research/`, `memoria.md` o las carpetas de planes y conversaciones.

## Referencia rápida

- [Setup](./setup.md) — requisitos, capacidades opcionales, configuración y distribución
- [Configuración de kitty](./kitty.md) — terminal usado para desarrollo (config activa + tema)
- [Dynamic Workflows — guía completa](./dynamic-workflows.md) — ciclo de ejecución, API de globals, background y resume, concurrencia, patrones y seguridad
- [Handbooks — referencia duradera del proyecto](./handbooks/README.md) — convenciones, onboarding y playbooks
- [Memoria de trabajo](./memoria.md) — registro de trabajo y decisiones

## Investigación y análisis

- [Ingeniería de loops con nuestras extensiones (how-to)](./loop-engineering-with-extensions.md)
- [Investigación: ultracode siempre activo](./research/2026-06-25-ultracode-always-on.md)
- [Mejorar prompts para dynamic workflows](./research/2026-06-25-prompt-patterns-workflows.md)
- [Recomendaciones de Andrej Karpathy sobre programación, aprendizaje y uso de IA](./research/2026-06-25-karpathy-programming-recommendations.md)
- [Patrones agénticos y papers aplicables a Dynamic Workflows](./research/2026-06-25-agentic-patterns-papers-workflows.md)
- [Visualización de patrones agénticos en Dynamic Workflows](./research/2026-06-25-agentic-patterns-visualization.md)
- [Principios de ingeniería de software según Dave Farley](./research/2026-06-25-dave-farley-modern-software-engineering.md)
- [Claude Dynamic Workflows: _A harness for every task_](./research/2026-06-26-claude-dynamic-workflows-harness.md)
- [Modularización de extensiones — Design Audit y roadmap](./research/2026-06-28-modularizacion-extensiones-design-audit.md)
- [Loop engineering — una investigación respaldada por fuentes](./research/2026-06-28-loop-engineering.md)

## Estructura del directorio

- `docs/html/` — espejo HTML generado con estilo Pandi; no se edita a mano y se regenera con `npm run sync:docs:html` (`npm test` falla si hay drift)
- `docs/handbooks/` — referencia duradera del proyecto (convenciones, onboarding y playbooks)
- `docs/research/` — notas de investigación, fuentes consultadas y decisiones de implementación
- `docs/workflows/` — documentación técnica de workflows y runs
- `docs/conversaciones/` — registro resumido de conversaciones y decisiones
- `docs/planes/` — planes de implementación y roadmaps con prioridades y dependencias

## Guía de documentación

Cada documento debería incluir fecha, contexto, archivos afectados y próximos pasos.
