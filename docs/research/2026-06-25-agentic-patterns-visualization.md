---
type: "Research Note"
title: "Visualización de patrones agénticos en Dynamic Workflows"
description: "Investigación sobre visualización de patrones agénticos en grafos de Dynamic Workflows."
tags: [agents, workflows, visualization, mermaid]
timestamp: 2026-06-25T00:00:00Z
---

# Visualización de patrones agénticos en Dynamic Workflows

Date: 2026-06-25

Este trabajo mejora `/workflow graph` para que deje de verse como una lista lineal de llamadas y, en cambio, muestre los
patrones agénticos relevantes: fan-out de muchos subagents por paso, pipelines por lanes/stages, barreras paralelas,
síntesis/judge y loops aproximados.

La señal clave es visual: si un paso lanza muchos agentes, eso tiene que verse en el diagrama. Además, el PNG inline
debe aparecer más grande para que la estructura se lea sin esfuerzo.

## En 30 segundos

Sirve cuando el grafo te está ocultando la forma real del workflow. Usalo para distinguir rápido entre secuencia,
fan-out, paralelismo y síntesis, y para comprobar que una etapa con muchos agentes no quedó aplastada en una sola
flecha.

## Cómo probarlo

```bash
PI_DYNAMIC_WORKFLOWS_PI_COMMAND=true pi --no-extensions -e ./extensions/dynamic-workflows.ts --no-session -p "/workflow graph generated/agentic-viz-patterns-research"
```

## Fuentes revisadas

**Documentación y frameworks:**

- Anthropic, **Building effective agents**: prompt chaining, routing, parallelization, orchestrator-workers,
  evaluator-optimizer.
- LangGraph, **Workflows and agents**: Mermaid/graph rendering of workflows, parallelization, routing,
  orchestrator-worker, evaluator-optimizer.
- Mermaid, **Flowchart syntax**: `subgraph`, local direction, edges to/from subgraphs, labels and shapes.
- Mermaid CLI (`mmdc`): flags `-w/--width`, `-H/--height`, `-s/--scale`, `-t`, `-b`, JSON config.

**Papers académicos:**

- ReAct (arXiv:2210.03629)
- Self-Consistency (arXiv:2203.11171)
- Reflexion (arXiv:2303.11366)
- Self-Refine (arXiv:2303.17651)
- Tree of Thoughts (arXiv:2305.10601)
- Multiagent Debate (arXiv:2305.14325)

**Investigación local:**

- Workflow `generated/agentic-viz-patterns-research`
- Run `2026-06-25T10-17-20-913Z-generated-agentic-viz-patterns-research-ef06f94c`
- Artifacts en el directorio `.pi/workflow-runs/...` del proyecto

## Gramática visual recomendada

- **◆ fan-out:** `ctx.agents(...)`; mostrar `P1 ×items.length agents`, `concurrency`, `settle:true`, fork, workers
  visibles y join.
- **▣ pipeline:** `ctx.pipeline(items, ...stages)`; mostrar `×items.length lanes` y la cantidad de stages.
- **⧉ barrier:** `ctx.parallel([...])`; mostrar ramas concurrentes y join/barrier.
- **● agent:** un subagent individual de Pi.
- **◇ workflow:** sub-workflow delegado.
- **▤ artifact:** evidencia persistida fuera del chat.
- **$ bash:** comando del host.
- **Feedback loops:** patrones ReAct/Reflexion/Self-Refine; se marcan como loops con condición de corte cuando se
  detecta `for`/`while`.

## Decisiones implementadas

1. **Modelo de grafo enriquecido**
   - `WorkflowGraphStep` ahora puede llevar `fanout` y `children`.
   - Se infiere cardinalidad estática conservadora: `angles.map(...)` → `angles.length`; arrays literales → número;
     desconocido → `dynamic`.
   - `concurrency`, `settle:true` y la cantidad de stages se extraen cuando aparecen en los argumentos.

2. **Agrupación de llamadas anidadas**
   - Las llamadas `ctx.agent`/helpers dentro de `ctx.pipeline`, `ctx.parallel` o `ctx.agents` se muestran como hijos del
     paso de orquestación, no como pasos seriales independientes.

3. **Mermaid con subgraphs**
   - Fan-outs/pipelines/barriers se renderizan como `subgraph` con `direction LR`.
   - Para muchos agentes, se dibujan workers representativos: `agent 1`, `agent 2`, `…`, `agent n` o `agent N`.
   - Las conexiones externas apuntan al subgraph, no a nodos internos, así no se rompe la dirección local de Mermaid.

4. **PNG más grande**
   - Render dinámico: `width 2200..3600`, `height 1300..2800`, `scale=2`.
   - TUI inline más grande: hasta `320` columnas y `54..88` filas según la complejidad.
   - La UI muestra las dimensiones generadas (`WIDTH×HEIGHT @2x`) junto a la ruta PNG/MMD.

5. **Documentación**
   - El README y el skill documentan que `/workflow graph` ahora muestra fan-out `×N`, lanes/branches y un PNG inline
     grande.

## Límites aceptados

- El grafo sigue siendo una vista estática: no ejecuta JS ni conoce el valor real de `files.length` antes de la corrida.
- Los conteos reales post-run existen en `phaseTotal`/`phaseIndex`/`phaseLabel` para `ctx.agents(...)`; una mejora
  futura aware de la corrida puede combinar el grafo estático con los eventos de ejecución.
- La inferencia por regex sigue siendo heurística; un AST sería más robusto, pero esta mejora evita las serializaciones
  falsas más visibles sin subir demasiado el costo/dependencias.
- Los fan-outs enormes se colapsan con elipsis para mejorar la legibilidad; el PNG muestra que hay muchos agentes sin
  intentar dibujar cientos por defecto.

## Validación

Probá la implementación:

```bash
npm test
./node_modules/.bin/mmdc -q -i /tmp/subgraph-id-edge.mmd -o /tmp/subgraph-id-edge.png -e png -t dark -b transparent -w 2600 -H 1800 -s 2
```
