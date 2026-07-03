# Project documentation

This directory stores the project's work history, decisions, created workflows, and relevant conversations to serve as a durable reference and audit trail.

## Quick reference

- [Setup](./setup.md) — requirements, optional capabilities, configuration, distribution
- [Configuración de kitty](./kitty.md) — terminal usado para desarrollo (config activa + tema)
- [Dynamic Workflows — the full guide](./dynamic-workflows.md) — execution cycle, globals API, background & resume, concurrency, patterns, security
- [Handbooks (durable project reference)](./handbooks/README.md) — conventions, onboarding, and playbooks
- [Memoria de trabajo](./memoria.md) — work log and decisions

## Research & analysis

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

## Directory structure

- `docs/html/` — GENERATED pandi-styled HTML mirror of the docs (do not hand-edit; regenerate with `npm run sync:docs:html` — `npm test` fails on drift)
- `docs/handbooks/` — durable project reference (conventions, onboarding, playbooks)
- `docs/research/` — research notes, consulted sources, and implementation decisions
- `docs/workflows/` — technical documentation for workflows and runs
- `docs/conversaciones/` — summarized log of conversations and decisions
- `docs/planes/` — implementation plans and roadmaps with priorities and dependencies

## Documentation guidelines

Each document should include date, context, affected files, and next steps.
