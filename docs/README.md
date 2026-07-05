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

- [Loop engineering with our extensions (how-to)](./loop-engineering-with-extensions.md)
- [Research: ultracode always-on](./research/2026-06-25-ultracode-always-on.md)
- [Improving prompts for dynamic workflows](./research/2026-06-25-prompt-patterns-workflows.md)
- [Andrej Karpathy's recommendations for programming, learning, and using AI](./research/2026-06-25-karpathy-programming-recommendations.md)
- [Agentic patterns and papers applicable to Dynamic Workflows](./research/2026-06-25-agentic-patterns-papers-workflows.md)
- [Visualization of agentic patterns in Dynamic Workflows](./research/2026-06-25-agentic-patterns-visualization.md)
- [Software engineering principles according to Dave Farley](./research/2026-06-25-dave-farley-modern-software-engineering.md)
- [Claude Dynamic Workflows: a harness for every task](./research/2026-06-26-claude-dynamic-workflows-harness.md)
- [Modularización de extensiones — Design Audit y roadmap](./research/2026-06-28-modularizacion-extensiones-design-audit.md)
- [Research: loop engineering (source-backed)](./research/2026-06-28-loop-engineering.md)

## Estructura del directorio

- `docs/html/` — espejo HTML generado con estilo Pandi; no se edita a mano y se regenera con `npm run sync:docs:html` (`npm test` falla si hay drift)
- `docs/handbooks/` — referencia duradera del proyecto (convenciones, onboarding y playbooks)
- `docs/research/` — notas de investigación, fuentes consultadas y decisiones de implementación
- `docs/workflows/` — documentación técnica de workflows y runs
- `docs/conversaciones/` — registro resumido de conversaciones y decisiones
- `docs/planes/` — planes de implementación y roadmaps con prioridades y dependencias

## Guía de documentación

Cada documento debería incluir fecha, contexto, archivos afectados y próximos pasos.
