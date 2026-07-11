# Glosario de skills: nombres, capas y deferencia

Este glosario desambigua cómo nombrar **producto**, **skills**, **tools**, **patrones** y **comandos**
en prosa, docs y skills del repo. Para tokens congelados dentro de prompts (tools, schema keys,
`PASS`/`NO_FINDINGS`, etc.), ver [`glosario-prompts.md`](./glosario-prompts.md).

## En 30 segundos

- **Producto en prosa:** `dynamic workflows` (minúsculas).
- **Skill Pi:** `ultracode` · **Skill Claude:** `dynamic-workflows` (mirror byte-idéntico salvo `name`/H1).
- **Tool Pi:** `dynamic_workflow` · **Tool Claude:** `Workflow`.
- **Persona:** `persona usuaria` (canónico); no `usuario` salvo cuenta técnica (`tu usuario` de Pi) o username de GitHub.
- **Concepto:** `vibe-coding` (grafía canónica); en citas de fuentes externas conservá la forma original.

## Tabla de decisión: qué nombre usar

| Capa | Cuándo | Forma canónica | Ejemplos / notas |
| --- | --- | --- | --- |
| Producto (prosa) | Describir la capacidad multiagente del repo | `dynamic workflows` | "diseñar dynamic workflows", "guía para dynamic workflows" |
| Skill Pi | Frontmatter, invocación de skill en pi | `ultracode` | `.pi/skills/ultracode/SKILL.md`, `name: ultracode` |
| Skill Claude | Frontmatter, invocación en Claude Code | `dynamic-workflows` | `.claude/skills/dynamic-workflows/SKILL.md`; mirror de ultracode con `name`/H1 distintos |
| Skill Claude (alias) | Mismo contenido, nombre idéntico a pi | `ultracode` | `.claude/skills/ultracode/` — generado desde la fuente pi |
| Tool Pi | API runtime, ejemplos de código | `dynamic_workflow` | `dynamic_workflow({ action: 'start', … })` |
| Tool Claude | API runtime, ejemplos de código | `Workflow` | `Workflow({ name: 'router', args: {…} })` |
| Patrón / scaffold | Archivo ejecutable del catálogo | kebab-case literal | `fan-out-and-synthesize`, `complex-research`, `contract-gate` |
| Comando Pi | Slash commands de la extensión | `/dynamic-workflow`, `/ultracode`, … | `/deep-research`, `/workflow view`, `/ultracode-mode on` |
| Comando esfuerzo | Dial de esfuerzo del orquestador | `/effort ultracode` | Activa el skill de orquestación sin renombrar el producto |
| Extensión npm | Package publicable | `pandi-dynamic-workflows` | Vendorea skills `ultracode`, `default`, `deep-research` |
| Persona usuaria | Quien pide, revisa y posee el resultado | `persona usuaria` | En skills y docs de producto; no `usuario` genérico |
| Cuenta / identidad técnica | Scope de instalación o owner de GitHub | `usuario` permitido | "global para tu usuario" (cuenta Pi), `usuario andrestobelem` (GitHub) |
| Historia de producto | Término ágil estándar | `historia de usuario` | No confundir con "persona usuaria" |
| Concepto exploratorio | Prototipado sin rigor de producción | `vibe-coding` | Adjetivo: `vibe-coded`; no `vibe coding` en prosa propia |
| Lens skills | Guías de diseño cargables por agentes | ver tabla abajo | Deferencia explícita; no son el producto ni la tool |

## Patrones y scaffolds

Un **patrón** (o **scaffold**) es un archivo `.js` del catálogo, no solo un concepto:

| Contexto | Ruta / invocación |
| --- | --- |
| Fuente pi | `extensions/pandi-dynamic-workflows/scaffolds/<pattern>.js` |
| Inspección en pi | `dynamic_workflow action=scaffold name=<pattern>` |
| Mirror Claude | `reference/claude-workflows/<pattern>.js` en el skill |
| Catálogo legible | [`workflow-catalog.md`](./workflow-catalog.md), `reference/scaffold-catalog.md` |

Los nombres de patrón van siempre en **kebab-case** y entre backticks en prosa (`router`, no Router).

## Comandos frecuentes (Pi)

| Comando | Rol |
| --- | --- |
| `/dynamic-workflow <task>` | Router principal (alias `/ultracode <task>`) |
| `/deep-research <q>` | Atajo al patrón `complex-research` |
| `/ultracode-mode status\|on\|off` | Modo orquestación |
| `/ultracode-contract status\|on\|off` | Contract gate |
| `/workflow view\|runs\|resume` | Inspección de corridas |
| `/workflows` | Dashboard |
| `/workflow patterns` | Lista de scaffolds |
| `/workflow graph <name>` | Grafo de un workflow |

## Lens skills: deferencia y dueño

Los **lens skills** son guías de criterio; no reemplazan al skill de orquestación ni a las tools.

| Skill | Rol | Deferencia |
| --- | --- | --- |
| `ultracode` / `dynamic-workflows` | **Orquestación** — gates, primitivas, scaffolds, plataforma | Dueño de *cuándo* y *cómo* orquestar |
| `ai-assisted-engineering` | **Orquestador** — cuánto delegar a IA/agentes | Cuándo usar dynamic workflows vs inline |
| `modern-software-engineering` | **Delivery** — TDD, feedback, complejidad | Loop TDD por defecto; guía para dynamic workflows |
| `empirical-software-design` | **Micro-ritmo** — step size, tidy first/after | Ritmo fino dentro del loop de MSE |
| `clean-craftsmanship` | **Oficio** — SOLID, Clean Architecture, legibilidad | Límites de diseño en código y workflows |
| `karpathy-guidelines` | **Comportamiento** — cambios quirúrgicos, supuestos | Externo; `npm run doctor` reporta instalación |

Regla práctica: **orquestación** → `ultracode`; **criterio de delegación** → `ai-assisted-engineering`; **TDD y evidencia** → `modern-software-engineering`; **tamaño de paso** → `empirical-software-design`; **diseño limpio** → `clean-craftsmanship`.

## Mayúsculas: cuándo sí

| Caso | Forma |
| --- | --- |
| Prosa general, READMEs, skills | `dynamic workflows` |
| Título de sección que nombra el producto Pi explícitamente | `Pi Dynamic Workflows` (solo si el contexto es la extensión/runtime) |
| Literales de API, tools, comandos | Sin traducir: `dynamic_workflow`, `Workflow`, `/dynamic-workflow` |
| Nombres de skill en frontmatter | `ultracode`, `dynamic-workflows` |

## Capas de generación y sync

Los skills **no se editan en los destinos generados**. La fuente canónica es siempre
`.pi/skills/<name>/`. Desde ahí, tres pipelines distintos (clasificación en
`scripts/skill-classification.mjs`):

| Pipeline | Comando | Origen | Destino | Qué copia |
| --- | --- | --- | --- | --- |
| **Mirror Pi↔Claude** | `npm run sync:skills` | `.pi/skills/<name>/` | `.claude/skills/<name>/` | Byte-idéntico (`mirrored: true` en classification) |
| **Ultracode Claude** | `npm run sync:claude:ultracode` | `.pi/skills/ultracode/` | `.claude/skills/{ultracode,dynamic-workflows}/` | `SKILL.md` con rename mínimo de `name`/H1 + `reference/` verbatim |
| **Vendor extensión** | `npm run sync:skills:vendor` | `.pi/skills/<name>/` | `extensions/<ext>/skills/<name>/` | Árbol completo (`vendoredBy` en classification) |

`npm run doctor` chequea drift en los tres (`sync:skills:check`, `sync:skills:vendor:check`,
`sync:claude:ultracode:check`). Si falla, corré el fix correspondiente — **no parchees a mano**
`.claude/skills/ultracode/`, `dynamic-workflows/` ni `extensions/*/skills/`.

### Referencias dentro de `ultracode`

| Artifact | Fuente de verdad | Cómo llega al skill |
| --- | --- | --- |
| Primitivas (`agent`, `pipeline`, …) | `extensions/pandi-dynamic-workflows/primitives/*.md` | Mirror 1:1 a `reference/primitives/` (test `primitives-parity`) |
| Scaffolds Claude (`.js`) | `extensions/pandi-dynamic-workflows/scaffolds/*.js` | `node .claude/scripts/generate-claude-workflows.mjs` → `.claude/workflows/` + `reference/claude-workflows/`; luego `sync:claude:ultracode` + `sync:skills:vendor` propagan |
| Catálogo Claude (prosa) | `.claude/workflows/README.md` (inglés) | Snapshot manual en español: `reference/scaffold-catalog.md` y `reference/claude-workflows/README.md` — mantenerlos alineados en el mismo commit |
| Model tiers / alias mapping | `extensions/pandi-dynamic-workflows/runtime/tier-models.ts` | Documentado en `reference/operational-notes.md` y chuleta de `SKILL.md`; aliases `haiku`/`sonnet`/`opus`/`fable`; pi acepta ids `anthropic/…` o `openai-codex/gpt-5.x` |

### Orden seguro tras editar skills

1. Editá **solo** bajo `.pi/skills/` (y fuentes de extensión si aplica: scaffolds, primitives).
2. Si tocaste scaffolds: `node .claude/scripts/generate-claude-workflows.mjs`.
3. `npm run sync:claude:ultracode` → `npm run sync:skills:vendor` → `npm run sync:skills` (si el skill es mirrored).
4. `npm run doctor` o los tests de parity de `pandi-dynamic-workflows`.

Skills **project-local** (no mirrored ni vendored): `didactic-docs-style`, `pandi-prose-style`,
`markdownlint-cli2` — viven solo en `.pi/skills/`.

## Próximos pasos

- Traducís o redactás un skill → consultá esta tabla antes de elegir mayúsculas o sinónimos.
- Agregás un patrón al catálogo → actualizá [`workflow-catalog.md`](./workflow-catalog.md) en el mismo cambio si el patrón es user-facing.
- Token congelado en un prompt → [`glosario-prompts.md`](./glosario-prompts.md).
