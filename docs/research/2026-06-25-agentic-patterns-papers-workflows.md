# Patrones agénticos y papers aplicables a Dynamic Workflows

Fecha: 2026-06-25

## En 30 segundos

Esta nota resume los patrones y papers que más nos sirven para mejorar Pi Dynamic Workflows: prompts, plantillas, ejemplos, selección de concurrencia y criterios para decidir cuándo orquestar. La idea práctica es simple: primero scoutear barato, después fan-out solo cuando haya independencia real, y cerrar con una síntesis que juzgue con evidencia.

| Si necesitás... | Usá... | Señal mínima |
|---|---|---|
| Tareas independientes | `ctx.agents` | cada rama puede avanzar sola |
| Varios pasos por ítem | `ctx.pipeline` | una rama tiene su propia secuencia |
| Dedupe, ranking o juez global | `ctx.parallel` | hace falta una barrera común |

## Objetivo

Consolidar lo aprendido sobre workflows agénticos y papers relevantes para mejorar Pi Dynamic Workflows: prompts, plantillas, ejemplos, selección de concurrencia y criterios para decidir cuándo orquestar.

## Fuentes revisadas

- **ReAct: Synergizing Reasoning and Acting in Language Models** — arXiv:2210.03629. Idea útil: alternar razonamiento y acciones/herramientas; en workflows, separar scouting barato, ejecución con herramientas y síntesis con evidencia.
- **Self-Consistency Improves Chain of Thought Reasoning in Language Models** — arXiv:2203.11171. Idea útil: múltiples caminos independientes + selección por consenso; en workflows, usar fan-out de perspectivas y síntesis como juez.
- **Reflexion: Language Agents with Verbal Reinforcement Learning** — arXiv:2303.11366. Idea útil: memoria verbal de fallas y reflexión; en workflows, loops con artefactos de error, retries y verificación.
- **Self-Refine: Iterative Refinement with Self-Feedback** — arXiv:2303.17651. Idea útil: generar → criticar → refinar; en workflows, plan → crítica adversarial → plan revisado → checklist.
- **Tree of Thoughts: Deliberate Problem Solving with Large Language Models** — arXiv:2305.10601. Idea útil: ramificar/evaluar/podar; en workflows, generar alternativas en paralelo, evaluarlas con una rúbrica y podarlas antes de implementar.
- **Improving Factuality and Reasoning in Language Models through Multiagent Debate** — arXiv:2305.14325. Idea útil: el debate multiagente mejora la factualidad; en workflows, reviewers independientes y un juez que descarte afirmaciones sin soporte.
- **AutoGen: Enabling Next-Gen LLM Applications via Multi-Agent Conversation** — arXiv:2308.08155. Idea útil: patrones de conversación multiagente programables; en workflows, roles explícitos, contratos de salida y scopes de herramientas.
- **CAMEL: Communicative Agents for "Mind" Exploration of Large Language Model Society** — arXiv:2303.17760. Idea útil: cooperación con role-play y roles definidos; en workflows, `agentType` y responsabilidades no superpuestas.
- **MetaGPT: Meta Programming for A Multi-Agent Collaborative Framework** — arXiv:2308.00352. Idea útil: codificar workflows humanos en roles y artefactos; en workflows, artefactos estables y fases explícitas.
- **AgentVerse: Facilitating Multi-Agent Collaboration and Exploring Emergent Behaviors** — arXiv:2308.10848. Idea útil: ajustar dinámicamente la composición del grupo; en workflows, elegir cantidad y tipo de agentes después del scouting.
- **SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering** — arXiv:2405.15793. Idea útil: importa la interfaz agente-computadora; en workflows, herramientas restringidas, prompts con paths/comandos y artefactos inspectables.
- **DSPy: Compiling Declarative Language Model Calls into Self-Improving Pipelines** — arXiv:2310.03714. Idea útil: módulos declarativos y contratos; en workflows, schemas, formatos fijos y helpers reutilizables.

## Principios derivados

1. **Primero dinámico, no hardcodeado**
   - Crear workflows específicos de la tarea de forma dinámica; los ejemplos versionados son referencia, no jobs fijos.
   - Tratar los workflows generados como borradores bajo `generated/<task-slug>` y promoverlos a nombres estables solo si el usuario los aprobó o quiere reutilizarlos.
   - No fijar la cantidad de agentes o la `concurrency` sin mirar el problema.
   - Scoutear inline o dentro del workflow, medir la lista de trabajo y elegir fan-out según tamaño, costo, riesgo y pedido.

2. **Fan-out solo con independencia real**
   - Usar `ctx.agents` para ítems independientes.
   - Usar `ctx.pipeline` cuando cada ítem necesite varias etapas propias.
   - Usar `ctx.parallel` solo si hay una barrera real: deduplicación global, ranking cruzado, consenso o juez.

3. **Síntesis como juez, no como resumen pasivo**
   - El sintetizador debe juzgar, no promediar.
   - Debe descartar afirmaciones sin soporte, resolver contradicciones y preservar incertidumbre.

4. **La evidencia es contrato**
   - Cada subagente debe citar archivo/línea, URL, comando observado, o declarar `NO_FINDINGS` / `INSUFFICIENT_EVIDENCE`.
   - Los hallazgos sin evidencia no entran al resultado final.

5. **Falla parcial visible**
   - Usar `settle:true` en fan-outs grandes.
   - Filtrar `null`, registrar cuántas ramas fallaron y exigir que la síntesis mencione la cobertura parcial.

6. **Loops con freno explícito**
   - Reflexion/Self-Refine sugieren loops, pero deben tener condición de corte: máximo de rondas, rondas silenciosas, `maxAgents`, timeout o budget.
   - Usar `{ cache:false }` solo cuando se busca deliberadamente una muestra nueva.

7. **Roles y herramientas mínimas**
   - Especialización de roles: reviewer, researcher, planner, implementer.
   - Para auditorías, herramientas read-only.
   - Para implementación, separar plan/review de la edición real.

8. **Artefactos como memoria externa**
   - Persistir la lista de trabajo, salidas crudas, descartes, síntesis, checks y riesgos aceptados.
   - No depender de que todo entre en el contexto del chat.

## Cambios aplicados

- README: agregó patrones respaldados por investigación y una explicación de workflows dinámicos/concurrency dinámica.
- `dynamic-workflows` skill: reforzó reglas de decisión, patrones y falla parcial.
- Base template: ahora scoutea, registra límites, elige la concurrencia dinámicamente y usa `settle:true`.
- Ejemplos: `repo-bug-hunt`, `deep-research` y `adversarial-plan-review` ahora eligen concurrencia dinámicamente, registran fallas parciales y usan personas/settling.
- Ultracode explícito: `/ultracode` ahora fuerza una instrucción más operativa ("create a task-specific workflow dynamically with `dynamic_workflow` in this turn if it passes the gate"), prefiere `generated/<task-slug>` como borrador y activa la herramienta `dynamic_workflow` si estaba inactiva.
- TUI/widget: endureció el render para `width <= 0` y sanitiza mensajes de log antes de renderizar.
- Política actualizada: `examples/` no debe contener `.pi`; abrir Pi desde la raíz del repo o copiar ejemplos a un proyecto temporal.

## Validación

```bash
node --check examples/workflows/repo-bug-hunt.js
node --check examples/workflows/deep-research.js
node --check examples/workflows/adversarial-plan-review.js
npx --yes esbuild extensions/dynamic-workflows.ts --platform=node --format=esm --packages=external --outfile=/tmp/pi-dynamic-workflows-check.mjs
./node_modules/.bin/tsc --noEmit --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext --types node extensions/dynamic-workflows.ts
pi --no-extensions -e ./extensions/dynamic-workflows.ts --list-models __no_such_model__
PI_DYNAMIC_WORKFLOWS_PI_COMMAND=true pi --no-extensions -e ./extensions/dynamic-workflows.ts --no-session -p "/ultracode-mode status"
```

Desde `examples/`:

```bash
PI_DYNAMIC_WORKFLOWS_PI_COMMAND=true pi --no-session -p "/workflow list"
```

## Siguientes pasos recomendados

- Agregar scaffolds de patrones: `judge-panel`, `adversarial-verify`, `loop-until-dry`, `multi-modal-sweep`, `pipeline`.
- Agregar linting pre-run para detectar caps silenciosos y `concurrency` hardcodeada.
- Mejorar `/ultracode` siempre activo para que distinga entre "decide workflow" y "force workflow" y registre la decisión cuando afecte costo/latencia.
