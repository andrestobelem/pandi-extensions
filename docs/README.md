# Documentación del proyecto

Esta carpeta reúne el historial de trabajo del proyecto, sus decisiones, los workflows creados y las conversaciones
relevantes. Es una referencia duradera y un rastro de auditoría al que siempre podés volver. 🐼

## En 30 segundos

Si querés ubicarte rápido, empezá por la guía de `Setup`, la documentación de `Dynamic Workflows` o los `Handbooks`. Si
buscás contexto histórico o decisiones, entrá en `research/` o `memoria.md`.

## Referencia rápida

- [README raíz](../README.md) — entrada narrativa: qué es Pandi, cómo instalarlo y por dónde empezar
- [Setup](./setup.md) — requisitos, capacidades opcionales, configuración y distribución
- [Dynamic Workflows — guía completa](./dynamic-workflows.md) — ciclo de ejecución, API de globals, background y resume,
  concurrencia, patrones y seguridad
- [Scaffolds](./scaffolds/index.md) — páginas didácticas del catálogo: cuándo usar cada patrón, diagrama y comando
  mínimo
- [Handbooks — referencia duradera del proyecto](./handbooks/README.md) — convenciones, onboarding y playbooks
- [Onboarding top-down para programadores](./handbooks/top-down-onboarding.md) — ruta de lectura del repo, roles de
  trabajo y criterio para comentarios traducidos
- [Configuración de kitty](./kitty.md) — terminal usado para desarrollo (config activa + tema)
- [Memoria de trabajo](./memoria.md) — registro de trabajo y decisiones

El sitio HTML generado vive en `docs/html/`. No se edita a mano: sale del Markdown con `npm run sync:docs:html` y
`npm test` detecta drift.

## Investigación y análisis

- [Índice OKF de investigación](./research/index.md) — mapa navegable de las notas en `docs/research/`
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

- `docs/html/` — espejo HTML generado con estilo Pandi; no se edita a mano y se regenera con `npm run sync:docs:html`
  (`npm test` falla si hay drift)
- `docs/handbooks/` — referencia duradera del proyecto (convenciones, onboarding y playbooks; empezá por
  `top-down-onboarding.md` si querés entender el código)
- `docs/research/` — notas de investigación, fuentes consultadas y decisiones de implementación
- `docs/scaffolds/` — libro de patrones agénticos corribles, una página por scaffold
- `docs/*.md` — guías principales, setup, ingeniería de extensiones y memoria del proyecto

## Guía de documentación

Cada documento público debería abrir con 30 segundos de contexto, avanzar de ejemplo mínimo a referencia, y mantener
links a Markdown fuente. Si necesitás una versión visual, regenerá `docs/html/`; si necesitás cambiar contenido, editá
Markdown.
