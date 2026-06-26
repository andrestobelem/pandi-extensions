# Visualización de patrones agénticos en Dynamic Workflows

Fecha: 2026-06-25

## Objetivo

Mejorar `/workflow graph` para que deje de parecer una lista lineal de llamadas y muestre patrones agénticos relevantes: fan-out de muchos subagentes por paso, pipelines por lanes/stages, barreras paralelas, síntesis/judge y loops aproximados. Requisito explícito: si un paso lanza muchos agentes, eso debe verse en el diagrama; el PNG inline debe verse más grande.

## Fuentes revisadas

- Anthropic, **Building effective agents**: prompt chaining, routing, parallelization, orchestrator-workers, evaluator-optimizer.
- LangGraph, **Workflows and agents**: Mermaid/graph rendering de workflows, parallelization, routing, orchestrator-worker, evaluator-optimizer.
- Mermaid, **Flowchart syntax**: `subgraph`, dirección local, edges hacia/desde subgraphs, labels y shapes.
- Mermaid CLI (`mmdc`): flags `-w/--width`, `-H/--height`, `-s/--scale`, `-t`, `-b`, config JSON.
- Papers: ReAct (arXiv:2210.03629), Self-Consistency (arXiv:2203.11171), Reflexion (arXiv:2303.11366), Self-Refine (arXiv:2303.17651), Tree of Thoughts (arXiv:2305.10601), Multiagent Debate (arXiv:2305.14325).
- Investigación paralela local: workflow `generated/agentic-viz-patterns-research`, run `2026-06-25T10-17-20-913Z-generated-agentic-viz-patterns-research-ef06f94c`, artifacts en el directorio `.pi/workflow-runs/...` del proyecto donde se ejecutó.

## Gramática visual recomendada

- `◆ fan-out`: `ctx.agents(...)`; mostrar `P1 ×items.length agents`, `concurrency`, `settle:true`, fork, workers visibles y join.
- `▣ pipeline`: `ctx.pipeline(items, ...stages)`; mostrar `×items.length lanes` y número de stages.
- `⧉ barrier`: `ctx.parallel([...])`; mostrar branches concurrentes y join/barrier.
- `● agent`: un subagente Pi individual.
- `◇ workflow`: sub-workflow delegado.
- `▤ artifact`: evidencia persistida fuera del chat.
- `$ bash`: comando host.
- Feedback loops (ReAct/Reflexion/Self-Refine) deben marcarse como loops con stop condition cuando se detectan `for`/`while`.

## Decisiones implementadas

1. **Modelo de grafo enriquecido**
   - `WorkflowGraphStep` ahora puede llevar `fanout` y `children`.
   - Se infiere cardinalidad estática conservadora: `angles.map(...)` → `angles.length`; arrays literales → número; desconocido → `dynamic`.
   - Se extraen `concurrency`, `settle:true` y número de stages cuando aparecen en argumentos.

2. **Agrupación de llamadas anidadas**
   - Llamadas `ctx.agent`/helpers dentro de `ctx.pipeline`, `ctx.parallel` o `ctx.agents` se muestran como hijas del paso de orquestación, no como pasos seriales independientes.

3. **Mermaid con subgraphs**
   - Fan-outs/pipelines/barriers se renderizan como `subgraph` con `direction LR`.
   - Para muchos agentes se dibujan workers representativos: `agent 1`, `agent 2`, `…`, `agent n` o `agent N`.
   - Las conexiones externas apuntan al subgraph, no a nodos internos, para no romper la dirección local de Mermaid.

4. **PNG más grande**
   - Render dinámico: `width 2200..3600`, `height 1300..2800`, `scale=2`.
   - Inline TUI más grande: hasta `320` columnas y `54..88` filas según complejidad.
   - La UI muestra dimensiones generadas (`WIDTH×HEIGHT @2x`) junto al path PNG/MMD.

5. **Documentación**
   - README y skill documentan que `/workflow graph` ahora muestra fan-out `×N`, lanes/branches y PNG inline grande.

## Limitaciones aceptadas

- El grafo sigue siendo una vista estática: no ejecuta JS ni conoce el valor real de `files.length` antes del run.
- Los conteos reales post-run existen en `phaseTotal/phaseIndex/phaseLabel` para `ctx.agents(...)`; una futura mejora run-aware puede mezclar el grafo estático con eventos de run.
- La inferencia por regex sigue siendo heurística; un AST sería más robusto, pero esta mejora evita los falsos seriales más visibles y mantiene bajo el costo/dependencias.
- Fan-outs enormes se colapsan con ellipsis para legibilidad; el PNG muestra que hay muchos agentes sin intentar dibujar cientos por defecto.

## Validación

```bash
npm test
PI_DYNAMIC_WORKFLOWS_PI_COMMAND=true pi --no-extensions -e ./extensions/dynamic-workflows.ts --no-session -p "/workflow graph generated/agentic-viz-patterns-research"
./node_modules/.bin/mmdc -q -i /tmp/subgraph-id-edge.mmd -o /tmp/subgraph-id-edge.png -e png -t dark -b transparent -w 2600 -H 1800 -s 2
```
