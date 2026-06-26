# Patrones agénticos y papers aplicables a Dynamic Workflows

Fecha: 2026-06-25

## Objetivo

Consolidar lo aprendido sobre workflows agénticos y papers relevantes para mejorar nuestros Dynamic Workflows de Pi: prompts, templates, ejemplos, selección de concurrencia y criterios de cuándo orquestar.

## Fuentes revisadas

- **ReAct: Synergizing Reasoning and Acting in Language Models** — arXiv:2210.03629. Idea útil: alternar razonamiento y acciones/herramientas; en workflows, separar scout barato, ejecución con tools y síntesis con evidencia.
- **Self-Consistency Improves Chain of Thought Reasoning in Language Models** — arXiv:2203.11171. Idea útil: varias rutas independientes + selección por consenso; en workflows, usar fan-out de perspectivas y síntesis-as-judge.
- **Reflexion: Language Agents with Verbal Reinforcement Learning** — arXiv:2303.11366. Idea útil: memoria verbal de fallos y reflexión; en workflows, loops con artifacts de errores, reintentos y verificación.
- **Self-Refine: Iterative Refinement with Self-Feedback** — arXiv:2303.17651. Idea útil: generar → criticar → refinar; en workflows, plan → crítica adversarial → plan revisado → checklist.
- **Tree of Thoughts: Deliberate Problem Solving with Large Language Models** — arXiv:2305.10601. Idea útil: branch/evaluate/prune; en workflows, generar alternativas paralelas, evaluarlas por rubric y podar antes de implementar.
- **Improving Factuality and Reasoning in Language Models through Multiagent Debate** — arXiv:2305.14325. Idea útil: debate multiagente mejora factualidad; en workflows, reviewers independientes y juez que descarte claims no evidenciados.
- **AutoGen: Enabling Next-Gen LLM Applications via Multi-Agent Conversation** — arXiv:2308.08155. Idea útil: patrones de conversación multiagente programables; en workflows, roles explícitos, contratos de salida y tool scopes.
- **CAMEL: Communicative Agents for “Mind” Exploration of Large Language Model Society** — arXiv:2303.17760. Idea útil: cooperación role-play con roles definidos; en workflows, `agentType` y responsabilidades no solapadas.
- **MetaGPT: Meta Programming for A Multi-Agent Collaborative Framework** — arXiv:2308.00352. Idea útil: codificar workflows humanos en roles y artifacts; en workflows, artifacts estables y fases explícitas.
- **AgentVerse: Facilitating Multi-Agent Collaboration and Exploring Emergent Behaviors** — arXiv:2308.10848. Idea útil: ajustar composición del grupo dinámicamente; en workflows, elegir cantidad/tipo de agentes tras scout.
- **SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering** — arXiv:2405.15793. Idea útil: la interfaz agente-computadora importa; en workflows, tools restringidas, prompts con rutas/commands y artifacts inspeccionables.
- **DSPy: Compiling Declarative Language Model Calls into Self-Improving Pipelines** — arXiv:2310.03714. Idea útil: módulos declarativos y contratos; en workflows, schemas, formatos fijos y helpers reutilizables.

## Principios derivados

1. **Dynamic-first, no hardcode-first**
   - Crear workflows task-specific dinámicamente; los ejemplos versionados son referencias, no jobs fijos.
   - Tratar los workflows generados como borradores bajo `generated/<task-slug>` y promoverlos a nombres estables solo si al usuario le gustaron o quiere reutilizarlos.
   - No fijar cantidad de agentes/concurrencia sin mirar el problema.
   - Hacer scout inline o dentro del workflow, medir la work-list, y elegir fan-out según tamaño, coste, riesgo y pedido.

2. **Fan-out solo con independencia real**
   - Usar `ctx.agents` para items independientes.
   - Usar `ctx.pipeline` cuando cada item requiere varias etapas propias.
   - Usar `ctx.parallel` solo si hay una barrera real: dedup global, ranking cruzado, consenso o juez.

3. **Synthesis-as-judge, no resumen pasivo**
   - El sintetizador debe juzgar, no promediar.
   - Debe descartar claims sin evidencia, resolver contradicciones y preservar incertidumbre.

4. **Evidencia como contrato**
   - Cada subagente debe citar archivo/línea, URL, comando observado o declarar `NO_FINDINGS` / `INSUFFICIENT_EVIDENCE`.
   - Los findings sin evidencia no pasan a la salida final.

5. **Partial failure visible**
   - Usar `settle:true` en fan-outs grandes.
   - Filtrar `null`, loguear cuántas ramas fallaron y obligar a la síntesis a mencionar cobertura parcial.

6. **Loops con freno explícito**
   - Reflexion/Self-Refine sugieren loops, pero deben tener stop condition: rondas máximas, quiet rounds, maxAgents, timeout o budget.
   - Usar `{ cache:false }` solo cuando se busca una nueva muestra deliberadamente.

7. **Roles y tools mínimos**
   - Role specialization: reviewer, researcher, planner, implementer.
   - Para auditorías, tools read-only.
   - Para implementación, separar plan/review de edición real.

8. **Artifacts como memoria externa**
   - Persistir work-list, outputs crudos, descartes, síntesis, checks y riesgos aceptados.
   - No depender de que todo entre en el contexto del chat.

## Cambios aplicados

- README: se agregaron patrones research-backed y explicación de workflows dinámicos/concurrencia dinámica.
- Skill `dynamic-workflows`: se reforzaron reglas de decisión, patrones y partial failure.
- Template base: ahora hace scout, loguea caps, elige concurrencia dinámicamente y usa `settle:true`.
- Ejemplos: `repo-bug-hunt`, `deep-research` y `adversarial-plan-review` pasan a elegir concurrencia dinámicamente, loguear fallas parciales y usar personas/settling.
- Ultracode explícito: `/ultracode` ahora fuerza una instrucción más operativa (“crear un workflow task-specific dinámicamente con `dynamic_workflow` en este turno si pasa el gate”), prefiere `generated/<task-slug>` como borrador y activa el tool `dynamic_workflow` si estaba inactivo.
- TUI/widget: se endureció render para `width <= 0` y se sanitizan mensajes de logs antes de renderizar.
- Política actualizada: `examples/` no debe contener `.pi`; abrir Pi desde la raíz del repo o copiar ejemplos a un proyecto temporal.

## Validación

```bash
node --check examples/workflows/repo-bug-hunt.js examples/workflows/deep-research.js examples/workflows/adversarial-plan-review.js
npx --yes esbuild extensions/dynamic-workflows.ts --platform=node --format=esm --packages=external --outfile=/tmp/pi-dynamic-workflows-check.mjs
./node_modules/.bin/tsc --noEmit --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext --types node extensions/dynamic-workflows.ts
pi --no-extensions -e ./extensions/dynamic-workflows.ts --list-models __no_such_model__
PI_DYNAMIC_WORKFLOWS_PI_COMMAND=true pi --no-extensions -e ./extensions/dynamic-workflows.ts --no-session -p "/ultracode-mode status"
```

Desde `examples/`:

```bash
PI_DYNAMIC_WORKFLOWS_PI_COMMAND=true pi --no-session -p "/workflow list"
```

## Próximos pasos recomendados

- Agregar scaffolds de patrón: `judge-panel`, `adversarial-verify`, `loop-until-dry`, `multi-modal-sweep`, `pipeline`.
- Agregar lint pre-run para detectar caps silenciosos y concurrencia hardcodeada.
- Mejorar `/ultracode` always-on para que distinga “decidir workflow” de “forzar workflow” y loguee la decisión cuando afecte coste/latencia.
