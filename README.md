# pandi-extensions

**Un libro de patrones agénticos que se ejecuta.** Este repo destila los patrones multi-agente de la literatura (Tree of Thoughts, Reflexion, orchestrator-workers…) en **25 scaffolds corribles de JavaScript**. **Una suite de 21 extensiones más un tema para [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)** — el CLI de coding agent `@earendil-works/pi-coding-agent` — convierte a Pi en el laboratorio donde correrlos: graficarlos antes, inspeccionar journal y artifacts después, y verificar con evidencia en vez de fe.

El corazón es **Dynamic Workflows / Ultracode**: scripts de JavaScript confiables que Pi ejecuta para orquestar subagentes en paralelo, persistir artifacts fuera del contexto del chat y devolver una síntesis coordinada. Alrededor, cada extensión operacionaliza una disciplina de ingeniería — `/plan` ≈ pensar antes de codear, `/goal` ≈ ejecución con criterios verificables, `/loop` ≈ cambios quirúrgicos con safeguards — además de memoria local, auto-compactación de contexto, diagnósticos de TypeScript, git worktrees, sandboxes Linux y varios aliases/shortcuts de UX. Son piezas independientes: podés instalarlas una por una o todas juntas, según lo que necesite tu proyecto. 🐼

<div align="center">
  <img src="docs/assets/pandi-avatar-pixel.png" alt="Avatar pixel-art de Pandi con brillo magenta y bambú" width="220">
  <img src="docs/assets/pandi-avatar-pixel-meditating.png" alt="Avatar pixel-art de Pandi meditando con brote de bambú" width="220">
</div>

- **Licencia:** MIT · **Repo:** <https://github.com/andrestobelem/pandi-extensions>
- **Requisitos mínimos:** Node.js ≥ 22.19.0 + el CLI de Pi + git. Requisitos completos y capacidades opcionales: [`docs/setup.md`](docs/setup.md).

## Inicio rápido

```bash
# 0. Node >= 22.19.0 (se recomienda nvm; el repo trae .nvmrc)
nvm install && nvm use

# 1. Instalá el runtime de Pi globalmente
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version

# 2. Cloná el repo e instalá el toolchain de desarrollo
git clone https://github.com/andrestobelem/pandi-extensions.git
cd pandi-extensions
npm install

# 3. Verificá el entorno y luego corré el gate completo
npm run doctor
npm test

# 4. Instalá TODAS las extensiones + skills en Pi (global para tu usuario)
pi install ./                       # local al proyecto: pi install -l ./

# 5. Abrí Pi en tu proyecto, confiá en él y hacé un smoke test
cd /your/project && pi
#   dentro de Pi:  /trust  y luego  /reload
#   /effort status      (router de ultracode)
#   /workflows          (dashboard TUI)  o  /workflow patterns
```

Los extras opcionales (web search para subagentes, docs de Context7, gráficos PNG, sandboxes Apple `container`, micro-VMs de Gondolin) y la skill externa `karpathy-guidelines` están cubiertos en [`docs/setup.md`](docs/setup.md).

## Cómo leer este repo

Este repo funciona como **paquete instalable** y como **libro práctico**. Elegí la ruta más chica que te lleve al próximo experimento verificable:

| Si querés… | Empezá por | Después mirá |
| --- | --- | --- |
| Instalar y probar Pandi | [`docs/setup.md`](docs/setup.md) | `/effort status`, `/workflow patterns` |
| Entender Dynamic Workflows | [`docs/dynamic-workflows.md`](docs/dynamic-workflows.md) | [`docs/scaffolds/`](docs/scaffolds/index.md) |
| Aprender patrones agénticos | [`docs/scaffolds/`](docs/scaffolds/index.md) | [`docs/research/`](docs/research/index.md) |
| Entender el código top-down | [`docs/handbooks/top-down-onboarding.md`](docs/handbooks/top-down-onboarding.md) | `extensions/<name>/README.md` + tests de integración |
| Desarrollar extensiones | [`docs/developing-extensions.md`](docs/developing-extensions.md) | `extensions/<name>/README.md` + [`docs/handbooks/`](docs/handbooks/README.md) |
| Navegar como sitio HTML | `docs/html/index.html` | mirror generado de este README + `docs/**/*.md` |

Regla simple: **Markdown es la fuente; HTML es el artifact generado**. Editá `README.md` o `docs/**/*.md`, corré `npm run sync:docs:html`, y commiteá ambos si el mirror cambió.

## El concepto: patrones que se corren, no que se leen

Los patrones de diseño agénticos suelen vivir en papers y posts. Acá cada uno tiene una **implementación de referencia corta y legible** que podés leer, correr y auditar (`/workflow patterns` muestra el catálogo; [`docs/scaffolds/`](docs/scaffolds/index.md) son las páginas del libro):

| De dónde viene | Scaffolds (entre otros) |
| --- | --- |
| Papers (ReAct, Self-Consistency, Reflexion, Self-Refine, Tree of Thoughts) | `react-scout`, `self-consistency`, `reflexion`, `self-refine`, `tree-of-thoughts` |
| "Building effective agents" (Anthropic) | `router`, `orchestrator-workers`, `fan-out-and-synthesize` |
| Ingeniería clásica y verificación | `map-reduce`, `guardrails`, `contract-gate`, `adversarial-verify`, `tournament` |

El harness es el laboratorio: cada corrida deja **evidencia inspeccionable**, no solo una conclusión —

- un **graph** del patrón antes de ejecutar (`dynamic_workflow action=graph`),
- un **journal reanudable** de cada llamada (`/workflow resume latest` continúa sin reejecutar lo terminado),
- **artifacts** persistidos en `.pi/workflows/runs/<run-id>/`,
- un **reporte HTML** autocontenido por corrida (`dynamic_workflow action=report`).

Y la progresión es deliberada — nadie empieza orquestando 16 agentes; el router de Ultracode elige el camino más liviano que pueda verificar la respuesta:

```mermaid
flowchart LR
    A[prompt simple] --> B[scout inline]
    B --> C[scaffold del catálogo]
    C --> D[draft propio en drafts/]
    D --> E[workflow-factory]
```

## Dynamic Workflows en 60 segundos

Un Dynamic Workflow — el runtime del libro — es un **script de JavaScript trusted** que Pi ejecuta para orquestar trabajo grande con subagentes. El modelo mental es **MapReduce con agentes**: scoutear barato la lista real de trabajo, abrir ramas independientes con contratos de evidencia, persistir artifacts fuera del chat y dejar que una síntesis final haga deduplicación y priorización.

```js
export default async function main() {
  const items = [
    { label: "a", prompt: "Review src/a.ts", tools: ["read", "grep", "find", "ls"], agentType: "reviewer" },
    { label: "b", prompt: "Review src/b.ts", tools: ["read", "grep", "find", "ls"], agentType: "reviewer" },
  ];
  const reviews = await agents(items, { concurrency: 2, settle: true });
  await writeArtifact("reviews.json", reviews);
  return compact(reviews.filter(Boolean), 20000);
}
```

Puntos clave:

- **Globals inyectados, sin imports**: `agent`/`agents`, `pipeline`, `parallel`, `race`, `ask`, `workflow`, `bash`, `readFile`/`writeArtifact`, `log`, `compact`, más `args` y `limits` en modo read-only.
- **Personas**: `agentType: "explore" | "reviewer" | "planner" | "architect" | "implementer" | "researcher"` aplica defaults por rol (todos read-only por defecto); las opciones explícitas ganan.
- **Background por defecto** en sesiones TUI/RPC, con dashboard en vivo (`/workflows`) y artifacts por corrida en `.pi/workflows/runs/<run-id>/`.
- **Resume idempotente**: las llamadas `agent()` completadas quedan journaled y no se reejecutan; `/workflow resume <runId>` continúa una corrida interrumpida en el mismo lugar.
- **Ultracode always-on**: un router estilo Claude Code que decide, para cada tarea sustantiva, si conviene responder inline u orquestar un workflow (`/effort ultracode`, `/ultracode-mode`).

Guía completa — ciclo de ejecución, API completa, concurrencia, journal de resume, catálogo de patterns, seguridad: [`docs/dynamic-workflows.md`](docs/dynamic-workflows.md).

### Plantillas apoyadas en research

Mapeo de papers/frameworks comunes de agentes al diseño de workflows en Pi:

- **ReAct** -> scoutear/observar con tools antes del fan-out; mantener el razonamiento atado a la evidencia.
- **Self-consistency** -> muestrear ramas independientes y luego elegir por consistencia/evidencia, en vez de confiar en un solo camino.
- **Reflexion / Self-Refine** -> loops de generate -> critique -> refine, siempre acotados por rondas, quiet stops, `maxAgents` y timeout.
- **Tree of Thoughts** -> ramificar alternativas, evaluar/podar con un judge y luego comprometerse con un camino.
- **Multiagent debate** -> reviewers adversariales más síntesis-como-juez; los claims sin soporte se descartan.
- **AutoGen / CAMEL / MetaGPT** -> roles explícitos, artifacts estables y contratos de handoff claros.
- **SWE-agent / DSPy** -> importan la interfaz y los contratos: tools estrechos, schemas/formatos fijos y chequeos reproducibles.

Usalos como patterns, no como ceremonia: cada rama necesita una razón, un contrato y una condición de parada.

## Catálogo de extensiones

Las 21 extensiones de comando/tool se cargan por defecto desde el campo `pi.extensions` de `package.json` cuando corrés `pi install ./`; `pandi-theme` se registra a través de `pi.themes`. Cada extensión también se puede instalar por separado con `pi install ./extensions/<name>`.

| Extensión | Surface (human · model) | Qué hace | Requisitos extra |
| --- | --- | --- | --- |
| **pandi-dynamic-workflows** (core) | `/workflow`, `/workflows`, `/ultracode`, `/dynamic-workflow`, `/deep-research`, `/ultracode-mode`, `/ultracode-contract` · `dynamic_workflow` | Runtime de workflows JS para orquestación multiagente con ejecución en paralelo, artifacts y resume idempotente. | opcional: mmdc, web_search, Context7 |
| **pandi-loop** | `/loop` · `loop_schedule`, `loop_stop` | Loop iterativo con cadencia dinámica o fija, conducido por el modelo o por la extensión. | TUI/RPC; `autopilot` requiere trust |
| **pandi-goal** | `/goal` · `goal_progress` | Loop guiado por objetivo con chequeo obligatorio de finalización y verificador independiente opcional. | TUI/RPC |
| **pandi-plan** | `/plan` · `enter_plan_mode`, `submit_plan` | Modo de plan read-only con mutaciones bloqueadas hasta que apruebes explícitamente el plan. | TUI/RPC (o `PI_PLAN_NONINTERACTIVE=1`) |
| **pandi-effort** | `/effort status\|off\|minimal\|low\|medium\|high\|xhigh\|ultracode` | Selector de nivel de pensamiento estilo Claude; `ultracode` habilita el workflow router. | `ultracode` necesita el core cargado |
| **pandi-local-memory** | `remember` | Memoria local en `.pi/memory/`: índice auto-inyectado + archivos temáticos on-demand. | ⚠ auto-inyecta memoria: solo proyectos trusted |
| **pandi-auto-compact** | `/auto-compact [bar\|summary\|snapshot\|snapshots\|clear-tools]` | Compacta el contexto al pasar un umbral, con resumen rápido/acotado, snapshots recuperables y barra de progreso. | configurable vía `PI_AUTO_COMPACT_*` |
| **pandi-typescript-lsp** | `/tsc` · `typescript_diagnostics` | Feedback de `tsc --noEmit` acotado a los archivos tocados en este turno; no bloqueante. | proyecto con `tsconfig.json` |
| **pandi-worktree** | `/worktree` · `git_worktree` | Administra git worktrees desde Pi; abre sesiones nuevas y nunca cambia el cwd. | git + un repo git |
| **pandi-container** | `/container` · `container_sandbox` | Ejecuta comandos Linux aislados en micro-VMs Apple `container`, sin tocar el host. | macOS Apple Silicon + `container` |
| **pandi-bg** | `/bg` | Jobs en background en memoria para comandos humanos puntuales; no son resumables (el hermano pequeño de `dynamic_workflow`). | trust para `start` |
| **pandi-mdview** | `/mdview` · `view_markdown` | Abre un archivo Markdown en el viewer TUI con scroll de Pi. | — |
| **pandi-docs** | `/docs` · `markdown_to_html` | Convierte Markdown en artifacts HTML autocontenidos con estilo pandi (light + dark). | — |
| **pandi-btw** | `/btw` | Pregunta lateral rápida sobre la conversación actual, sin tools, en un overlay; no se guarda en el historial. | — |
| **pandi-improve-prompt** | `/improve-prompt` | Reescribe un prompt borrador para que sea más claro y accionable, y ofrece enviarlo como tu próximo mensaje. | TUI/RPC para confirmar el envío |
| **pandi-rename** | `/rename` | Renombra la sesión o genera el nombre automáticamente desde el historial (estilo Claude). | opcional: `PI_RENAME_*` |
| **pandi** | `/pandi [art\|face\|off\|on]` | Personaje panda: splash animado, indicador, verbos y mood. | TUI para el efecto completo |
| **pandi-exit** | `/exit` | Alias estilo Claude de `/quit` para una salida limpia. | — |
| **pandi-clear** | `/clear` | Alias estilo Claude de `/new` para empezar una sesión nueva. | — |
| **pandi-ask** | · `ask_choice`, `ask_confirm` | Tools interactivos de selector/confirmación TUI para puntos de decisión guiados por el modelo. | TUI/RPC |
| **pandi-doctor** | `/doctor` | Ejecuta el chequeo read-only de entorno del repo (`scripts/doctor.mjs`) y muestra el reporte. | — |

> `extensions/shared/` no es una extensión: es código de test harness; nunca se publica ni se carga. `extensions/pandi-theme/` tampoco envía código: es un package solo de temas (`pi.themes`) con las variantes `panda-syntax-dark`/`panda-syntax-light`, el compañero visual de **pandi**; se carga con `pi install ./` y se habilita vía `/settings` o `"theme"`.

## Comandos de todos los días

```text
/workflows                              # dashboard TUI (Monitor/Agents/Sessions/Runs/Workflows/Patterns/Activity)
/workflow run bug-hunt {"maxFiles":40,"concurrency":6,"maxAgents":16}
/workflow view latest                   # timeline + artifacts de la corrida más reciente
/workflow resume latest                 # retoma una corrida interrumpida sin reejecutar agentes terminados
/ultracode audit the whole repo for concurrency bugs
/deep-research research options to migrate X to Y
/effort ultracode                       # pensamiento xhigh + workflow router estilo Claude
/plan                                   # modo de plan read-only; las mutaciones esperan tu aprobación
/loop fix the failing tests             # loop iterativo con cadencia dinámica
/goal make npm test pass                # goal loop con verificación independiente
/bg start npm test                      # background job humano de una sola vez (ver extensions/pandi-bg/README.md)
```

Algunas extensiones también exponen tools que **Pi decide usar por su cuenta** (no como slash commands humanos): `enter_plan_mode`/`submit_plan` (planificar antes de cambios riesgosos; solo vos aprobás), `remember` (persistir notas durables en `.pi/memory/`), `git_worktree`, `container_sandbox`, `typescript_diagnostics`, `ask_choice`/`ask_confirm`, `loop_schedule`/`loop_stop` y `goal_progress`. El README de cada extensión documenta su surface.

## Documentación

El README raíz es la puerta de entrada; `docs/` es el libro completo; `docs/html/` es el espejo HTML navegable y generado por `npm run sync:docs:html`.

- [`docs/setup.md`](docs/setup.md) — requisitos completos, capacidades opcionales, configuración por env vars, canales de distribución y layout del repo.
- [`docs/dynamic-workflows.md`](docs/dynamic-workflows.md) — guía profunda de Dynamic Workflows: ciclo de ejecución, API de globals, background y resume, concurrencia, catálogo de patterns, prompts y seguridad.
- [`docs/scaffolds/`](docs/scaffolds/index.md) — las páginas del libro: una guía didáctica por scaffold, con diagrama, cuándo usarlo y cómo lanzarlo.
- [`docs/handbooks/`](docs/handbooks/README.md) — referencia duradera del proyecto: convenciones, onboarding y playbooks.
- [`docs/developing-extensions.md`](docs/developing-extensions.md) — cómo desarrollar extensiones en este repo self-hosted sin romper tu sesión.
- [`RELEASING.md`](RELEASING.md) — política de versiones, tag de suite y publish npm de `@pandi-coding-agent/*`.
- [`extensions/<name>/README.md`](extensions) — documentación por extensión (por ejemplo [`pandi-dynamic-workflows`](extensions/pandi-dynamic-workflows/README.md), [`pandi-bg`](extensions/pandi-bg/README.md)).

## Verificación

```bash
npm test
```

El gate corre, en este orden: `tsc` (typecheck de todas las extensiones), `biome check .` (lint + format de JS/TS/JSON), `markdownlint-cli2` (Markdown) y las suites de integración colocalizadas vía `scripts/test/run-all.mjs`. Verificá primero tu entorno con `npm run doctor`.

## Seguimiento de issues

El trabajo se sigue en el GitHub Project **[pandi-extensions](https://github.com/users/andrestobelem/projects/4)** (board v2).

- Las stories, tasks y bugs son [Issues](https://github.com/andrestobelem/pandi-extensions/issues) del repo, con labels `story` / `task` / `bug` / `tests` / `tech-debt`.
- El board los agrupa por **Status** (Todo / In Progress / Done); una story padre enlaza sus sub-tareas en el body.
- ¿Terminaste trabajo? Poné `Closes #N` en el commit para que el issue y su card del board se cierren automáticamente.
- Se gestiona desde terminal con el CLI [`gh`](https://cli.github.com/) (por ejemplo `gh issue create`, `gh project item-add 4 --owner andrestobelem`).

## Licencia

MIT — ver [`LICENSE`](./LICENSE).
