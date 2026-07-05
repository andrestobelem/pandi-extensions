---
type: "Research Note"
title: "Mejorar prompts para dynamic workflows"
description: "Mapa de patrones de prompting para dynamic workflows y subagentes."
tags: [prompts, workflows, subagents, evidence]
timestamp: 2026-06-25T00:00:00Z
---

# Mejorar prompts para dynamic workflows

Fecha: 2026-06-25

## En 30 segundos

Este documento resume qué patrones de prompting conviene aplicar a los dynamic workflows y qué archivos se actualizaron con esos criterios. La idea es simple: cada subagent debe poder rendir por sí solo, la síntesis debe filtrar afirmaciones sin evidencia y los fallos parciales no se deben perder. Si estás ajustando prompts, acá tenés el mapa corto de decisiones y verificación.

## Objetivo

Aplicar lo aprendido sobre patrones de workflow agentic a los prompts que usan nuestros dynamic workflows.

## Patrones aplicados

- **Fan-out independiente**: cada subagent recibe instrucciones para producir un resultado autocontenido, aunque fallen otros agentes.
- **Contrato de evidencia**: exigir citas a archivos/líneas, URLs, comandos observados, o marcar `INSUFFICIENT_EVIDENCE` / `NO_FINDINGS`.
- **Formato fijo**: los prompts piden secciones repetibles como veredicto, hallazgos, evidencia, riesgos, fix y verificación.
- **Synthesis-as-judge**: los agentes de síntesis deben deduplicar, descartar afirmaciones sin evidencia, preservar la incertidumbre y elegir una recomendación concreta.
- **Crítica adversarial**: los reviewers tienen el objetivo explícito de encontrar edge cases, reducir el alcance y marcar riesgos aceptados.
- **Manejo de fallos parciales**: la síntesis debe mencionar agentes fallidos, vacíos, cancelados o agotados por timeout.
- **Seguridad por defecto**: en auditorías, se refuerza "do not edit files" y las herramientas quedan en modo read-only.

## Workflows actualizados

Borradores internos e implementación:
- `.pi/workflows/drafts/agentic-workflow-patterns-research.js`
- `.pi/workflows/background-workflow-implementation-plan.js`

Workflows centrales:
- `.pi/workflows/review-dynamic-workflows.js`
- `.pi/workflows/revisar-estado-actual.js`
- `.pi/workflows/inventar-mejor-tui-workflows.js`
- `.pi/workflows/inventar-mejor-tui-workflows-lite.js`
- `.pi/workflows/karpathy-programming-recommendations-research.js`

Ejemplos:
- `examples/workflows/adversarial-plan-review.js`
- `examples/workflows/deep-research.js`
- `examples/workflows/repo-bug-hunt.js`

## Docs actualizadas

- `README.md`: sección "Recommended prompt patterns".
- `.pi/skills/dynamic-workflows/SKILL.md`: sección "Prompting Patterns".
- `docs/memoria.md`: preferencia persistente.
- `docs/research/2026-06-25-karpathy-programming-recommendations.md`: síntesis recuperada de Karpathy como criterios de prompt/workflow.

## Decisiones

- No se lanzó otro workflow para esta tarea porque los workflows más recientes con subagents quedaron colgados sin procesos visibles. Se hizo, en cambio, un refactor directo y verificable.
- Todavía no se agregó un helper compartido de prompts para evitar acoplar ejemplos simples al runtime interno.
- Se priorizó mejorar prompts antes que cambiar la API.

## Verificación esperada

- `node --check` sobre todos los workflows JS.
- Carga de extensión: `pi --no-extensions -e ./extensions/dynamic-workflows.ts --list-models __no_such_model__`.
