---
name: ultracode
description: >-
  Orquestá tareas con dynamic workflows multiagente en vez de resolverlas inline, tanto en Claude
  Code (tool `Workflow`) como en pi (tool `dynamic_workflow`). Activar cuando la persona usuaria
  escriba "ultracode" o "workflow" como pedido de orquestación, o cuando una tarea justifique
  paralelismo por exhaustividad, confianza o escala: auditorías repo-wide, migraciones/codemods,
  investigación profunda, verificación adversarial, generate-and-filter / best-of-N, ranking por
  torneo, loop-until-done discovery, decompose-an-open-goal o corpus mayor que una ventana de
  contexto. Usá para acotar pedidos ambiguos de alto riesgo (contract-gate), elegir el workflow
  correcto (router), crear uno nuevo (workflow-factory), o componer/proteger una corrida
  multiagente.
---

# ultracode

Primero decidí si conviene orquestar, después diseñá el workflow y recién entonces ejecutalo. Este
skill es **autocontenido y dual-platform**: los *conceptos* (cuándo orquestar, primitivas,
prompting, seguridad) se comparten; la *API* concreta cambia entre **Claude Code (Anthropic)** y
**pi** (un runtime que corre sobre Anthropic o OpenAI/Codex). En [Referencia de plataforma](#referencia-de-plataforma)
está la tool, los helpers y la forma de invocación de cada uno.

## En 30 segundos

`ultracode` orquesta tareas multiagente cuando inline no alcanza (exhaustividad, confianza o escala).
Primero gates; después primitiva o patrón; al final la tool de tu plataforma. Ejemplo mínimo en pi:

```js
dynamic_workflow({ action: 'start', name: 'task-slug', input: { request: '…' }, concurrency: 4 })
```

Glosario de nombres (producto vs skill vs tool): [`docs/handbooks/glosario-skills.md`](../../../docs/handbooks/glosario-skills.md).
Para criterio de delegación (inline vs orquestar), deferí a `ai-assisted-engineering`; este skill gobierna el cómo una vez decidido orquestar.
Detalle operativo (fan-out, model tiers, catálogo completo): [`reference/operational-notes.md`](reference/operational-notes.md).

El catálogo del lado de Claude vive en `reference/catalog-prose.es.md` (fuente canónica en español);
`npm run sync:scaffold-catalog` propaga snapshots a `reference/scaffold-catalog.md` y
`.claude/workflows/README.md` para el detalle completo por workflow.

## Cuándo orquestar (gates, en orden)

Para casi todo, una sola llamada a un agente le gana a un workflow. Recorré estos gates en orden;
la mayoría de las tareas terminan temprano.

0. **Contract Gate.** Convertí el pedido bruto en un contrato inspeccionable: tarea mejorada,
   success criteria, supuestos, non-goals, plan de verificación y blockers. Si la ambigüedad bloquea
   el routing o la implementación, inferí criterios concisos cuando sea seguro o hacé **solo** las
   preguntas bloqueantes. Routeá desde la tarea mejorada, no desde la original.
1. **Trivial.** Si es conversacional, de un paso o de apenas unas tool calls → hacelo directo. Un
   workflow consume muchas model calls; no pagues ese costo por una edición rápida, un lookup o un
   cambio en un solo archivo.
2. **Scout inline primero.** Si una tarea *podría* ser grande, sondéala barato en el turno actual
   (`git ls-files`, leer el diff, grep/glob, listar candidatos). Eso revela la work-list real y su
   tamaño. Necesitás entender la forma antes del *orchestration step*, no antes de la *task*.
3. **Orquestá solo por una razón real.** Después del scout, armá un workflow solo si vale una de
   estas razones: **Exhaustiveness** (muchos ítems independientes para cubrir en paralelo),
   **Confidence** (alto riesgo; perspectivas independientes + verificación adversarial *antes* de
   commitear) o **Scale** (más de una ventana de contexto: auditorías repo-wide, migraciones grandes,
   sweeps amplios con artifacts). Si ninguna aplica, quedate con un solo agente.

### Escalá el esfuerzo al pedido

| Pedido | Forma |
| --- | --- |
| "find some bugs", "quick read" | scout → fan-out chico (~3-5 finders) → síntesis liviana |
| "review this plan", "is this safe" | pocos reviewers con perspectivas diversas → synthesis-as-judge |
| "audit thoroughly", "be exhaustive" | pool más grande → chequeo adversarial por finding → judge → repetir mientras aparezcan findings nuevos |

### Dimensionar el fan-out (concurrency y budget de agentes)

No tomes los defaults bajos como techo. Subí el fan-out para ramas read-only e independientes;
mantenelo bajo con side effects, modelos caros o dependencias secuenciales. Logueá con `log()` todo
cap, sample o clamp. Presupuestá el peor caso cuando el fan-out dependa de resultados (jurados por
finding). Para scopes grandes, evitá `schema` estricto y timeouts default (~10 min) sin ajustar —
ver [notas operativas](reference/operational-notes.md#dimensionar-el-fan-out-detalle).

### Lectura de archivos grandes

Seguí como default la guía repo-wide de `AGENTS.md` / `CLAUDE.md`. En prompts de workflows, no les
pidas a los workers que "read every file fully" sobre scopes grandes; deciles que primero hagan
scout, que paginen archivos grandes con `Read` `offset`/`limit` cuando haga falta, que superpongan
ventanas de código, achiquen ventanas densas y reporten la cobertura parcial de forma explícita.
Para inputs enormes, partí chunks semánticos en `agents()`/`pipeline()` o elegí `map-reduce` en vez
de incrustar un archivo gigante en un prompt.

## Elegir una primitiva

Elegí por dependencia de datos, no por estética. Resumen:

| Necesidad | Primitiva |
| --- | --- |
| Un paso independiente por ítem | `agents(items, { concurrency })` |
| Stages dependientes por ítem, sin merge global | `pipeline(items, ...stages)` — **default** |
| Un paso necesita TODOS los resultados a la vez | `parallel([...])` — solo para barreras reales |
| Sub-workflow reutilizable | `workflow(name, args)` |
| Primera respuesta buena; cancelar el resto | `race(thunks, { accept? })` — **solo pi** |
| Decisión humana a mitad de corrida | `ask(question, opts?)` — **solo pi** |

**Runtime note:** `race`/`ask` viven en el runtime pi de `dynamic_workflow`; no asumas que existen
en `Workflow` de Claude Code.

**Settle semantics:** ramas fallidas → `null`; filtrá nulls y `log()` cuántas fallaron.

Referencia completa de globals y gotchas: [`reference/primitives/README.md`](reference/primitives/README.md)
y [globals en notas operativas](reference/operational-notes.md#globals-inyectados-referencia-completa).

## Model y effort por llamada

`model` (capacidad por token) y `effort` (budget de razonamiento) son **dos diales independientes**.
Seteá ambos explícitamente en cada nodo con fan-out; no acoples "modelo barato" con "pensamiento
barato". Pisos orientativos:

| Tipo de trabajo | Piso model | Piso effort |
| --- | --- | --- |
| Extracción mecánica, verificada downstream | haiku | `low` |
| Scout que rankea work-list | haiku | `low`–`medium` |
| Review read-only por ítem | sonnet | `medium` |
| Worker que muta el árbol | sonnet | `medium`–`high` |
| Judge / synthesis FINAL | opus | `high` |

Tablas de tiers, providers pi (Anthropic/Codex), post-mortem #47 y reglas de cache key:
[notas operativas · model/effort](reference/operational-notes.md#model-y-effort-por-llamada-detalle).

## Seguridad y prompting (resumen)

Fenceá datos no confiables (pedido, archivos, salida de otros agentes) con delimitadores
infalsificables; combiná con tools read-only y judges conservadores. Usá evidence contracts
(`NO_FINDINGS`, `INSUFFICIENT_EVIDENCE`), synthesis-as-judge y prefijos estables para prompt-cache.
Detalle: [notas operativas](reference/operational-notes.md).

## Catálogo de patrones

25 scaffolds en `extensions/pandi-dynamic-workflows/scaffolds/`; en pi:
`dynamic_workflow action=scaffold name=<pattern>`. Tabla por familia y mapeo research→scaffold:
[notas operativas · catálogo](reference/operational-notes.md#el-catálogo-de-patrones-por-familia).
Vista rápida: [`reference/scaffold-catalog.md`](reference/scaffold-catalog.md) y
[`docs/handbooks/workflow-catalog.md`](../../../docs/handbooks/workflow-catalog.md).

## PHASE 0 — contract-gate (siempre, para corridas sustantivas)

1. En Pi, corré el scaffold canónico `contract-gate` sobre el pedido bruto; la extensión lo usa como workflow read-only.
2. Si necesita aclaración → devolvé las preguntas bloqueantes a la persona usuaria y STOP.
3. Si se puede avanzar → usá el prompt reescrito como handoff durable hacia router /
   workflow-factory / el workflow elegido.
4. Propagá el resource plan del gate (`{ tier, models, efforts }`) al budget de la corrida aguas
   abajo.

## Referencia de plataforma

**Claude Code:** tool `Workflow`; globals `agent`, `parallel`, `pipeline`, `workflow`, `phase`,
`log`, `args`; budget en `args` vía helper local `node(role)` o inline; catálogo
`~/.claude/workflows/`; depth 1. Invoke mínimo:

```js
Workflow({ name: 'router', args: { request: 'the task', model: 'sonnet', effort: 'medium' } })
```

Obligatorio en Claude: render HTML pre-launch + `open`, lanzar sin aprobación, re-render con `--run`
al terminar. Detalle: [notas operativas · plataforma](reference/operational-notes.md#referencia-de-plataforma-detalle).

**pi:** tool `dynamic_workflow`; mismos globals de composición más `race`, `ask`, bash, filesystem y
artifacts; budget por llamada + personas `agentType`; depth 2 (→3); resume journaled. Invoke mínimo:

```js
dynamic_workflow({ action: 'start', name: 'task-slug', input: {…}, concurrency: 8, maxAgents: 40 })
```

Monitor sin polling (completion notice del harness); reporte final con `/workflow report` o
`dynamic_workflow action="report"`. Comandos: `/dynamic-workflow`, `/ultracode`, `/deep-research`,
`/workflow view|runs|resume`, `/workflows`, `/workflow patterns|graph`.

### Chuleta

| Aspecto | Claude Code (Anthropic) | pi (Anthropic o Codex) |
| --- | --- | --- |
| Tool | `Workflow` | `dynamic_workflow` |
| Script API | helper globals (`agent`, `parallel`, …) | los mismos helper globals (`agent`, `parallel`, …) |
| Budget knobs | `model` · `effort` (low…max) | `model`/`provider` · `effort` (`off\|minimal\|low\|medium\|high\|xhigh`; `max`→`xhigh`) |
| Models | `haiku`/`sonnet`/`opus`/`fable` | ids de Anthropic O `openai-codex/gpt-5.x` |
| Per-role | helper `node(role)` / inline / `models`+`efforts` | por llamada + personas `agentType` |
| Catalog | `~/.claude/workflows/` + README (desde `catalog-prose.es.md`) | `dynamic_workflow action=scaffold` |
| Depth | 1 | 2 (→3) |
| Preview / results | HTML pre-launch + `open`, luego re-render con `--run` al terminar (ambos obligatorios) | `/workflow graph`, dashboard `/workflows`, HTML final `--run latest` |

## Crear un workflow nuevo

**Basá todo workflow nuevo en el scaffold existente más cercano; nunca reinventes.** Preferí
**`workflow-factory`** antes que hand-roll. Convenciones: `meta.basedOn` con procedencia de scaffolds;
parseá `args` defensivamente; `model`/`effort` explícitos por nodo; loops acotados + `log()`; settle
semantics, evidence contracts y fences. En Claude: renderizá + abrí HTML y lanzá directo. Detalle en
[notas operativas · plataforma](reference/operational-notes.md#referencia-de-plataforma-detalle).
