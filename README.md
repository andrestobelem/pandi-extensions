# pandi-extensions

**Una suite de 21 extensiones más un tema para [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)** — el CLI de coding agent `@earendil-works/pi-coding-agent` — que lleva a Pi la ergonomía y las capacidades de Claude Code: **dynamic multi-agent workflows** (la pieza central), además de `/loop`, `/goal`, `/plan`, memoria local, auto-compactación de contexto, diagnósticos de TypeScript, git worktrees, sandboxes Linux y varios aliases/shortcuts de UX.

El corazón del repo es **Dynamic Workflows / Ultracode**: scripts de JavaScript confiables que Pi ejecuta para orquestar subagentes en paralelo, persistir artifacts fuera del contexto del chat y devolver una síntesis coordinada. El resto de las extensiones son piezas independientes: podés instalarlas una por una o todas juntas, según lo que necesite tu proyecto. 🐼

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
| **pandi-auto-compact** | `/auto-compact [bar\|snapshot\|snapshots\|clear-tools]` | Compacta el contexto al pasar un umbral, con snapshots recuperables y barra de progreso. | configurable vía `PI_AUTO_COMPACT_*` |
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

## Dynamic Workflows en 60 segundos

Un Dynamic Workflow es un **script de JavaScript trusted** que Pi ejecuta para orquestar trabajo grande con subagentes. El modelo mental es **MapReduce con agentes**: scoutear barato la lista real de trabajo, abrir ramas independientes con contratos de evidencia, persistir artifacts fuera del chat y dejar que una síntesis final haga deduplicación y priorización.

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

- [`docs/setup.md`](docs/setup.md) — requisitos completos, capacidades opcionales, configuración por env vars, canales de distribución y layout del repo.
- [`docs/dynamic-workflows.md`](docs/dynamic-workflows.md) — guía profunda de Dynamic Workflows: ciclo de ejecución, API de globals, background y resume, concurrencia, catálogo de patterns, prompts y seguridad.
- [`docs/developing-extensions.md`](docs/developing-extensions.md) — cómo desarrollar extensiones en este repo self-hosted sin romper tu sesión.
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
