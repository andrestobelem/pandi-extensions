---
okf_version: "0.1"
---

# Índice OKF de investigación

Este directorio es un piloto de **Open Knowledge Format (OKF)** sobre las notas de investigación del repo. Cada archivo
Markdown no reservado es un concepto con frontmatter OKF; `index.md` organiza el bundle y `log.md` registra cambios del
conocimiento.

## En 30 segundos

Usá este índice para navegar las investigaciones por tema, no por fecha. Si necesitás el detalle completo, entrá al
concepto enlazado: cada uno conserva el informe original y agrega metadatos legibles por agentes.

## Workflows, agentes y orquestación

- [Patrones agénticos y papers aplicables](./2026-06-25-agentic-patterns-papers-workflows.md) — papers y patrones para
  diseñar workflows.
- [Visualización de patrones agénticos](./2026-06-25-agentic-patterns-visualization.md) — cómo representar fan-out,
  pipelines y barreras.
- [Mejorar prompts para dynamic workflows](./2026-06-25-prompt-patterns-workflows.md) — contratos de evidencia, síntesis
  y fallos parciales.
- [Ultracode siempre activo](./2026-06-25-ultracode-always-on.md) — router por defecto para decidir cuándo orquestar.
- [Claude Dynamic Workflows](./2026-06-26-claude-dynamic-workflows-harness.md) — comparación del harness de Claude Code
  con Pi.
- [Loop engineering](./2026-06-28-loop-engineering.md) — loops actuar → observar → verificar → continuar.
- [Revisión Farley de Pi Dynamic Workflows](./2026-07-03-farley-review-dynamic-workflows.md) — revisión técnica con
  lente de Modern Software Engineering.

## Ingeniería, contexto y diseño

- [Principios de Dave Farley](./2026-06-25-dave-farley-modern-software-engineering.md) — ingeniería moderna, aprendizaje
  y complejidad.
- [Recomendaciones de Andrej Karpathy](./2026-06-25-karpathy-programming-recommendations.md) — programación, aprendizaje
  y uso de IA.
- [Context Engineering: foco](./2026-06-28-context-engineering-focus.md) — mantener enfocado a un LLM y su harness.
- [Context Engineering aplicado](./2026-06-28-context-engineering-applied.md) — mapeo de esa investigación a nuestras
  extensiones.
- [Modularización de extensiones](./2026-06-28-modularizacion-extensiones-design-audit.md) — auditoría de diseño y
  roadmap.
- [Sistema de Personas (`agentType`)](./2026-06-29-persona-system-review.md) — revisión técnica de personas en
  workflows.

## Formatos de conocimiento y sesiones

- [Open Knowledge Format](./2026-06-30-open-knowledge-format.md) — investigación sobre OKF de Google Cloud.
- [OpenProse](./2026-07-04-openprose-analysis.md) — contratos declarativos para sesiones de IA.

## Auditorías y mantenimiento

- [Auditoría del repo](./2026-07-01-repo-audit-bugs-inconsistencias.md) — bugs e inconsistencias detectadas en revisión
  read-only.
- [Backlog del dashboard](./dashboard-improvement-backlog.md) — estado canónico de mejoras abiertas/cerradas.
- [Registro de mejoras del dashboard](./dashboard-improvement-log.md) — bitácora cronológica de cambios del dashboard.

## Convenciones del piloto

- `type` usa una taxonomía local pequeña: `Research Note`, `Research Review`, `Research Backlog`, `Research Log`.
- `tags` son cadenas cortas para navegación por agentes; no son una taxonomía cerrada.
- `timestamp` usa la fecha explícita del informe cuando existe; si no hay una fecha clara, se omite.
