# pi-dynamic-workflows

Implementación para **Pi** de workflows dinámicos estilo Claude Code: scripts JavaScript que orquestan subagentes de Pi en paralelo, guardan artefactos fuera del contexto del chat y devuelven una síntesis coordinada.

## Instalación

Desde este repo, global para tu usuario:

```bash
pi install ./
```

Instalación local al proyecto actual:

```bash
pi install -l ./
```

Probar sin instalar:

```bash
pi --no-extensions -e ./extensions/pi-dynamic-workflows/index.ts
# o cargar el paquete entero:
pi --no-extensions -e .
```

Para usar workflows de proyecto en `.pi/workflows/`, confía el proyecto con `/trust` y reinicia o ejecuta `/reload`.

### Paquetes individuales por extensión

Además del bundle raíz, cada directorio bajo `extensions/` es un Pi package instalable por separado:

| Extensión | Paquete local |
| --- | --- |
| Dynamic Workflows / Ultracode | `pi install ./extensions/pi-dynamic-workflows` |
| `/loop` | `pi install ./extensions/pi-loop` |
| `/goal` | `pi install ./extensions/pi-goal` |
| `/plan` | `pi install ./extensions/pi-plan` |
| `/bg` | `pi install ./extensions/pi-bg` |
| `/effort` | `pi install ./extensions/pi-effort` |
| `/mdview` | `pi install ./extensions/pi-mdview` |
| Local memory | `pi install ./extensions/pi-local-memory` |
| Auto-compact context | `pi install ./extensions/pi-auto-compact-context` |
| `/worktree` | `pi install ./extensions/pi-worktree` |
| TypeScript diagnostics | `pi install ./extensions/pi-typescript-lsp` |

Usa `pi install -l <ruta>` para instalación local al proyecto o `pi --no-extensions -e <ruta>` para probar sin instalar.

## Uso

Comandos humanos:

```text
/workflows                              # dashboard TUI monitor-first (tabs Monitor/Agents/Sessions/Runs/Workflows/Patterns/Activity)
↓ al fondo del editor / Ctrl+Alt+W       # shortcuts para abrir el dashboard desde el editor
/workflow dashboard                     # alias del dashboard TUI
/workflow sessions                      # abre el tab TUI de sesiones Pi vivas (TUI/RPC)
/workflow patterns                      # abre el catálogo TUI de patrones/scaffolds para crear workflows
/workflow list
/workflow graph bug-hunt                # visual Mermaid PNG grande en TUI; muestra fan-out ×N, lanes/branches y export Mermaid
/workflow runs                          # runs recientes
/workflow view latest                   # timeline + artifacts del último run
/workflow new bug-hunt --pattern=bug-hunt-repo-audit
/workflow edit bug-hunt
/workflow run bug-hunt {"maxFiles":40,"concurrency":6,"maxAgents":16}     # background por defecto en TUI/RPC
/workflow start bug-hunt {"maxFiles":40,"concurrency":4,"maxAgents":16}   # alias explícito background
/workflow bg bug-hunt {"maxFiles":40}                                      # alias
/workflow resume latest                 # reanuda en background por defecto en TUI/RPC
/workflow resume <runId> --force         # reanuda incluso un run completado
/workflow cancel latest                 # cancela una corrida activa en background
/workflow delete-run latest             # borra artifacts/directorio de una corrida ya inactiva
/workflow delete bug-hunt               # borra un workflow con confirmación
/workflows
/dynamic-workflow revisa todo el repo buscando bugs de concurrencia
/deep-research investiga opciones para migrar X a Y
/effort high                           # cambia el thinking effort: off|minimal|low|medium|high|xhigh
/effort ultracode                      # xhigh + router dinámico estilo Claude Code
/mdview README.md                      # visualiza un archivo Markdown con scroll en la TUI
/worktree                              # gestiona git worktrees: list|add|open|remove|prune
/worktree add -b feature ../wt-feature # crea un worktree en nueva branch
/worktree open -b feature feature      # crea (si falta) y abre Pi en el worktree (tab nueva en supacode)
/worktree remove ../wt-feature         # elimina un worktree (con confirmación)
/ultracode-mode status                 # muestra si el router always-on está activo
/ultracode-mode off                    # desactiva el router en esta sesión
/ultracode-mode on                     # vuelve a activarlo
```

También puedes empezar un mensaje con `ultracode ...` o `dynamic workflow ...` y la extensión lo transforma en una petición orientada a workflows.

Algunas extensiones exponen además tools que **Pi decide usar por su cuenta** (no son slash commands humanos): por ejemplo `enter_plan_mode`, que deja a Pi entrar en plan mode read-only por iniciativa propia antes de un cambio no trivial, multi-paso o riesgoso, investigar sin mutar y luego presentar el plan con `submit_plan` para tu aprobación explícita. Pi puede *entrar* en plan mode, pero solo tú *apruebas* en sesiones TUI/RPC. En `print`/`json` la entrada se rechaza por defecto, salvo el modo **no interactivo (plan-only)** — opt-in con el parámetro `nonInteractive` o `PI_PLAN_NONINTERACTIVE=1` — donde el gate read-only queda armado, no hay aprobación ni implementación, y el plan se devuelve como entregable (así un subagente de dynamic workflow puede planear sin mutar). Plan mode también admite knobs `ultracode`/`ultracodeSteps` (params, `--ultracode`/`--ultracode-steps`, o `PI_PLAN_ULTRACODE*`) para investigar/ejecutar con dynamic workflows, y `/plan dashboard` para seguir el estado. Otra es `remember`, que deja a Pi persistir notas durables (preferencias estables, convenciones del proyecto, decisiones clave) en una sección auto-gestionada bajo la carpeta `.pi/memory/` —el índice `MEMORY.md` se inyecta (con tope) y los archivos por tema `.pi/memory/<topic>.md` se leen on demand; idempotente y sin tocar lo que tú curaste— para tenerlas disponibles en sesiones futuras. Otra es `git_worktree`, que deja a Pi gestionar git worktrees (`list`/`add`/`remove`/`prune`) invocando `git` con un array de argumentos (nunca shell); `remove` nunca fuerza por defecto (requiere `force: true` explícito para descartar un worktree sucio) y, como el `cwd` de Pi es fijo en la sesión, reporta la ruta del worktree para que abras un nuevo Pi ahí en vez de "cambiarse".

### Ultracode always-on

La extensión activa por defecto un router estilo Claude Code `/effort ultracode`: en cada tarea sustantiva Pi evalúa si conviene resolver normalmente o crear/ejecutar un workflow dinámico. No fuerza workflows para tareas simples; solo añade criterio de ruteo al system prompt cuando el tool `dynamic_workflow` está disponible. El router always-on por sí solo no cambia el thinking level para evitar modificar coste/modelo sin una decisión explícita; `/effort ultracode` sí pide `xhigh` explícitamente.

Ultracode inyecta un recordatorio corto: reglas de decisión, claves de plantillas y composición. El catálogo detallado queda en `dynamic_workflow action=template`; antes de escribir un workflow debe inspeccionarlo, reutilizar un workflow existente solo si coincide exactamente o elegir el scaffold más cercano.

También incluye un Contract Gate de revisión del contrato de tarea: para tareas Ultracode sustantivas que sobreviven el trivial gate, Pi debe lanzar un workflow read-only pequeño que sintetice `improvedTask`, criterios de éxito, supuestos, no-objetivos y plan de verificación antes del scout/orquestación normal.

Úsalo sin prefijos: pide una tarea y Pi decidirá. Para controlar el modo durante la sesión:

```text
/effort high          # solo cambia el thinking level
/effort ultracode     # thinking xhigh + activa el router de workflows
/ultracode-mode status
/ultracode-mode off
/ultracode-mode on
```

Tool para el modelo: `dynamic_workflow` con acciones `list`, `template`, `read`, `write`, `run`, `start`, `resume`, `cancel`, `delete`, `graph`, `runs`, `view`. `template` sin `name` lista el catálogo de patrones; `template` con `name=<key>` devuelve el scaffold de ese patrón. En sesiones TUI/RPC persistentes, `run`, `start` y `resume` se lanzan **siempre en background** y devuelven enseguida un `runId`; `run` solo bloquea como fallback en print/json, donde no hay sesión viva para sostener un background run. `resume` reutiliza las llamadas ya completadas (ver "Runs reanudables").

## Cómo funcionan nuestros Dynamic Workflows

Un Dynamic Workflow es un **script JavaScript confiable** que Pi ejecuta para orquestar trabajo grande con subagentes. El patrón típico es:

- **Scout barato**: primero descubrir la lista real de trabajo (`git ls-files`, diff, grep, glob, etc.).
- **Fan-out controlado**: repartir archivos, temas, hipótesis o perspectivas entre subagentes paralelos.
- **Evidencia obligatoria**: cada rama debe devolver datos verificables: archivo/línea, URL, comando observado, o `NO_FINDINGS` / `INSUFFICIENT_EVIDENCE`.
- **Artifacts fuera del chat**: guardar outputs intermedios en el directorio del run para no depender del contexto conversacional.
- **Synthesis-as-judge**: un agente final deduplica, descarta claims sin evidencia, preserva incertidumbre y devuelve una conclusión priorizada.

Mentalmente, es un **MapReduce con agentes**:

- `map`: muchos subagentes trabajan en paralelo sobre unidades independientes.
- `reduce`: una síntesis final combina resultados, resuelve contradicciones y prioriza.

### Research-backed templates

Map common agent papers/frameworks to Pi workflow design:

- **ReAct** -> scout/observe with tools before fan-out; keep reasoning tied to evidence.
- **Self-consistency** -> sample independent branches, then select by consistency/evidence rather than trusting one path.
- **Reflexion / Self-Refine** -> generate -> critique -> refine loops, always bounded by rounds, quiet stops, `maxAgents`, and timeout.
- **Tree of Thoughts** -> branch alternatives, evaluate/prune with a judge, then commit to one path.
- **Multiagent debate** -> adversarial reviewers plus synthesis-as-judge; unsupported claims are dropped.
- **AutoGen / CAMEL / MetaGPT** -> explicit roles, stable artifacts, and clear handoff contracts.
- **SWE-agent / DSPy** -> interface and contracts matter: narrow tools, schemas/fixed formats, and reproducible checks.

Use these as patterns, not ceremony: every branch needs a reason, a contract, and a stop condition.

See detailed notes in `docs/research/2026-06-25-agentic-patterns-papers-workflows.md`.

### Ciclo de ejecución

Cuando lanzás un workflow (`/workflow run`/`start` o `dynamic_workflow action=run`/`start`), la extensión hace esto:

1. **Resuelve el workflow** por nombre, buscando en workflows de proyecto y globales.
2. **Crea un run** con `runId` y directorio propio bajo `.pi/workflows/runs/<run-id>/` o el root global equivalente.
3. **Persiste estado inicial**: `input.json`, `status.json`, `events.jsonl`, `codeHash` y carpeta `agents/`.
4. **Ejecuta el JS en un Worker** con una API `ctx` controlada. El workflow no necesita importar Pi: llama helpers como `ctx.agent`, `ctx.agents`, `ctx.bash`, `ctx.writeArtifact` y `ctx.log`.
5. **Lanza subagentes**: cada `ctx.agent()` ejecuta un proceso `pi -p --no-session --mode json` con prompt, tools, skills, extensiones, keys/env, modelo, thinking y timeouts configurables.
6. **Aplica límites**: `concurrency` limita cuántos subagentes corren a la vez; `maxAgents` limita cuántos subagentes totales puede gastar el run; los timeouts cortan agentes o workflows colgados.
7. **Guarda progreso y artifacts**: logs en `events.jsonl`, estado en `status.json`, outputs de subagentes en `agents/*.md` y artifacts definidos por el workflow.
8. **Devuelve resultado final**: el valor retornado por el workflow se guarda en `result.json` y se muestra como resumen.

### API mental del `ctx`

- `ctx.agent(prompt, opts)` — ejecuta un subagente Pi. Es la unidad cara: una llamada `pi -p`; `opts` puede definir `tools`, `excludeTools`, `skills`, `includeSkills`, `extensions`, `includeExtensions`, `keys`, `env`, modelo, schema y persona.
- `ctx.agents(items, opts)` — fan-out paralelo con concurrencia limitada.
- `ctx.agents(items, { settle: true })` — no tumba todo el batch si falla una rama; devuelve `null` para ramas fallidas.
- `ctx.pipeline(items, ...stages)` — flujo multi-etapa por item sin barrera global; útil cuando cada item necesita varios pasos encadenados.
- `ctx.parallel([async () => ...])` — barrera explícita cuando un paso posterior necesita todos los resultados juntos.
- `ctx.workflow(name, input)` — compone un sub-workflow reusable inline (profundidad 1) compartiendo el mismo run, límites, abort y cache/journal.
- `ctx.bash(command, opts)` — ejecuta shell desde el cwd del workflow; cacheable solo con `{ cache: true }`.
- `ctx.writeArtifact(name, data)` — persiste datos del run fuera del chat.
- `ctx.log(message, details)` — registra progreso visible en dashboard, status line y `events.jsonl`.
- `ctx.compact(value, maxChars)` — serializa y trunca resultados grandes para pasarlos a una síntesis.
- `ctx.limits` — límites efectivos read-only (`concurrency`, `maxAgents`, timeouts).

Acceso por subagente: `tools`/`excludeTools` limitan tools de Pi; por defecto los allowlists explícitos reciben además `web_search` cuando está disponible el paquete `pi-codex-web-search` (opt-out: `includeExtensions: false` o `excludeTools: ["web_search"]`). `skills: ["path/to/skill"]` carga skills explícitas (`includeSkills: true` las suma al discovery, `includeSkills: false` desactiva discovery); el discovery normal deja disponible `context7-cli` y, si usás una lista explícita de skills, Dynamic Workflows agrega `context7-cli` si lo encuentra (opt-out: `includeSkills: false`). `extensions: ["path/to/ext.ts"]` carga extensiones explícitas (`includeExtensions: true` habilita discovery); y `keys: ["GITHUB_TOKEN"]` expone solo esas variables de entorno al agente en un entorno aislado (los valores se redactan en artifacts/dashboard). Usa `env: { NAME: "value" }` solo cuando quieras inyectar explícitamente un valor; nunca escribas secretos en prompts.

### Background por defecto y resume

- **Background por defecto en TUI/RPC** (`run`, `start`, `resume`): devuelve rápido con `runId`; el run sigue mientras viva la sesión Pi y despierta al agente al finalizar.
- **Foreground fallback** (`run` en print/json): bloquea hasta terminar porque no hay sesión persistente para sostener un background run.
- **Resume** (`resume`): reanuda runs `stale`, `failed` o `cancelled` sin repetir subagentes ya completados; en TUI/RPC también va en background por defecto.

El resume funciona con un `journal.jsonl` content-addressed:

- `ctx.agent()` se cachea por defecto.
- `ctx.bash()` se cachea solo si se llama con `{ cache: true }`.
- Una llamada cacheada no ejecuta `pi -p`, no consume slot de concurrencia y no cuenta contra `maxAgents`.
- Una llamada en vuelo durante un crash no queda journaled, por lo tanto se reejecuta de forma segura.

### Cuándo usarlos

Usá workflows cuando haya una razón real de orquestación:

- **Exhaustividad**: muchos archivos/items independientes a cubrir.
- **Confianza**: revisión adversarial, varias perspectivas o verificación antes de tomar una decisión.
- **Escala**: más contexto del que conviene manejar en una sola conversación.

No los uses para tareas triviales: una edición chica, una pregunta simple o pocas tool calls directas son mejor single-agent.

### Catálogo de patrones y casos de uso

El tab `Patterns` y `/workflow patterns` muestran todos los scaffolds registrados y casos de uso. Los scaffolds están embebidos en la extensión, así que el paquete no depende de archivos bajo `examples/workflows/`. El catálogo visible queda reducido a nombres estilo Claude:

- **Templates**: `classify-and-act`, `fan-out-and-synthesize`, `adversarial-verification`, `generate-and-filter`, `tournaments`, `loop-until-done`.
- **Compose templates**: `compose-verify-claims`, `lib-verify-claims`, `workflow-factory`.
- **Use-cases**: `bug-hunt-repo-audit`, `large-migration`, `complex-research`, `plan-review`, `claim-bug-verification`.

Los nombres anteriores ya no se resuelven como aliases de patrones. Las intenciones legacy `deep-research` y `default` viven como skills que enrutan a `complex-research` y `fan-out-and-synthesize` respectivamente.

Smell test de composición: si no hay decisión humana/externa entre dos sub-pasos, usa `ctx.workflow()` dentro de un solo run; si necesitás leer resultados y decidir la siguiente fase, secuencia runs separados con `action=start/run` y `action=view`.

### Seguridad y coste

- Los workflows son **código confiable**, no un sandbox de seguridad fuerte.
- Pueden ejecutar JavaScript, `fetch`, `ctx.bash`, leer/escribir archivos del cwd y gastar muchas llamadas de modelo.
- Para auditorías, preferí tools read-only: `tools: ["read", "grep", "find", "ls"]`.
- Para capacidades, otorga por subagente solo las tools, skills, extensiones y keys/env vars necesarias; el dashboard muestra nombres/rutas y faltantes, nunca valores secretos.
- Siempre pasá límites explícitos en tareas grandes: `concurrency`, `maxAgents`, `timeoutMs`, `agentTimeoutMs`.

## Ubicación de workflows y artifacts

Los workflows estables se guardan en:

- Proyecto: `.pi/workflows/*.js`
- Global: `~/.pi/agent/workflows/*.js`

Los borradores task-specific generados se guardan al lado de los runs, en `.pi/workflows/drafts/*.js` (o `~/.pi/agent/workflows/drafts/*.js` para global). Promové a `.pi/workflows/` solo los workflows que quieras conservar como estables/reusables.

Los resultados/artifacts se guardan en `.pi/workflows/runs/<run-id>/` cuando el proyecto está trusted. En proyectos no confiados se usa un directorio global bajo `~/.pi/agent/workflows/runs/<hash>/`. Los PNG/Mermaid generados por `/workflow graph` se guardan en `.pi/workflows/graphs/` o en el root global equivalente. La extensión también lee `.pi` global (`~/.pi/agent/workflows/{drafts,runs,sessions}/`) como fallback para drafts, runs y sesiones.

Durante runs activos en background (default en TUI/RPC), Pi muestra el estado en la status line (`▶ wf ... /workflows ↓ monitor ← agents Ctrl+Alt+W`) y el dashboard es la torre de control. En print/json no hay TUI persistente: `run` bloquea como fallback y después se inspecciona con `/workflow view`/`dynamic_workflow action=view`. En modo interactivo, `/workflows`, `Ctrl+Alt+W` o `↓` cuando el editor ya no puede bajar más abre un dashboard TUI en tab `Monitor` por defecto; `←` cuando el editor ya no puede moverse más a la izquierda abre el mismo dashboard directamente en tab `Agents`, con tabs `Monitor`, `Agents`, `Sessions`, `Runs`, `Workflows`, `Patterns` y `Activity`. El tab `Patterns` muestra el catálogo compacto (`classify-and-act`, `fan-out-and-synthesize`, `adversarial-verification`, etc.) con cuándo usar cada uno, input esperado y primitivas; `Enter`/`n` crea un borrador de workflow de proyecto desde el scaffold seleccionado para editar antes de guardar. El Monitor prioriza el run activo o, si no hay ninguno, el último run; muestra workflow, estado, elapsed, active/stale, cantidad de agentes ejecutándose en paralelo (`actual/concurrency`) y pico, bash, artifacts, último log y `runDir`. Cuando hay subagentes, muestra una lista con estado, duración, código de salida, schema, tools, skills, extensiones, keys y disponibilidad/preview del prompt; los agentes lanzados por la misma llamada `ctx.agents(...)` se marcan como `P<fase> 1/n`, `P<fase> 2/n`, etc.; `↑`/`↓` seleccionan agente, `Enter`/`o` abre una vista live del agente (refresco cada 1s, output parseado, prompt y acceso; sin volcar el stdout JSON crudo) y `←`/`→` cambian de tab. El tab `Agents` lista todos los agentes registrados en los runs, agrupados por runs recientes, con el total paralelo actual arriba; `↑`/`↓` selecciona cualquiera y el panel inferior muestra estado, fase `1/n`, artifact, tools, skills, extensiones, keys, prompt preview y output preview antes de abrir el detalle live con `Enter`/`o`. El tab `Sessions` muestra las sesiones Pi TUI/RPC vivas para el proyecto mediante heartbeat (pid, modo, idle, session file y workflows activos), marcando filas stale si el proceso murió sin limpiar; `Enter` cambia la sesión actual a la seleccionada cuando hay `session file` disponible. Atajos dentro del dashboard: `v` abre el run completo, `g` abre el graph TUI (Mermaid PNG inline grande vía `mmdc` cuando el terminal soporta imágenes; el diagrama agrupa fan-outs `ctx.agents(...)` como `P1 ×items.length` con nodos visibles de agentes/ellipsis/join, además de lanes de `ctx.pipeline(...)` y branches de `ctx.parallel(...)`; fallback topología ASCII width-safe + export Mermaid), `c`/`x` cancela runs activos con confirmación, `r` rerun con confirmación usando `input.json` (o editor JSON si falta), en tabs `Monitor`/`Agents`/`Runs`/`Activity` `d`/Delete borra artifacts/directorio del run seleccionado si ya no está activo, en tab `Workflows` `d`/Delete borra el workflow seleccionado con confirmación, `q`/`esc` cierra. Las métricas no persistidas (tokens/coste/model/toolCalls) no se muestran. Después de cualquier ejecución puedes usar `/workflow view latest`, que también incluye una sección `Agents` y `Parallel agents`.

El camino normal es crear un workflow dinámicamente para la tarea concreta:

```text
/dynamic-workflow auditá este repo buscando bugs de concurrencia y proponé fixes verificados
```

O desde el tool:

```json
{ "action": "template" }
{ "action": "write", "name": "audit-concurrency-<slug>", "scope": "project", "code": "...workflow JS generado para esta tarea..." }
{ "action": "start", "name": "audit-concurrency-<slug>", "input": { "maxAgents": 20, "concurrency": 4 } }
```

Reusar un workflow existente solo corresponde si **calza exactamente** con la tarea; si no, se genera uno nuevo bajo `.pi/workflows/drafts/` como borrador task-specific gitignored.

### Guardar/promover un workflow dinámico

Un workflow generado dinámicamente debe tratarse como **borrador descartable** hasta que demuestre valor. Después de correrlo:

- Si no sirvió: se puede borrar con `/workflow delete <name>`.
- Si sirvió para esa tarea pero no será reusable: se puede dejar en `.pi/workflows/drafts/` como historial local.
- Si gustó y querés volver a usarlo: se **promueve** a un nombre estable copiando su código a otro workflow, por ejemplo:

```json
{ "action": "read", "name": "audit-concurrency-<slug>" }
{ "action": "write", "name": "audit-concurrency", "scope": "project", "code": "...mismo código, opcionalmente limpiado/generalizado..." }
```

Al promover, conviene generalizar inputs (`maxFiles`, `paths`, `angles`, `concurrency`), documentar el contrato al inicio del archivo y borrar detalles demasiado específicos del run original.

### Troubleshooting rápido

Si `/dynamic-workflow`, `/workflow`, `/workflows` o el dashboard no aparecen:

- Verificá que el paquete esté cargado en el cwd actual:

  ```bash
  pi list
  ```

- Arrancá Pi desde la raíz del repo o desde un proyecto temporal; evitá subdirectorios de tests/fixtures con su propia `.pi/`.
- Después de instalar/cambiar settings, ejecutá `/reload` o reiniciá Pi.
- `dynamic_workflow` debe estar activo. `/ultracode-mode on` intenta activarlo para la sesión.
- El dashboard `/workflows` requiere modo TUI. En `pi -p`/print usá `/workflow list`, `/workflow runs` y `/workflow view latest`.
- Background requiere sesión persistente TUI/RPC. En esas sesiones `/workflow run`, `/workflow start` y `dynamic_workflow action=run/start` lanzan background; en print/json `run` es fallback foreground.
- El graph visual necesita `mmdc` y soporte de imágenes del terminal (Kitty/Ghostty/WezTerm/Warp/iTerm2; Pi lo desactiva bajo tmux). Si `mmdc` falla por Chrome/Puppeteer, ejecutá `npx puppeteer browsers install chrome-headless-shell`.

## Estructura de extensiones

Cada extensión vive como un mini-paquete npm bajo `extensions/<nombre>/`:

```text
extensions/<nombre>/
  index.ts              # entrypoint de Pi
  *.ts                  # helpers runtime de esa extensión
  tests/unit/           # tests rápidos, si aplica
  tests/integration/    # suites durables de comportamiento
```

`package.json` publica solo archivos runtime con `files: ["extensions/*/*.ts", ...]`, así los tests quedan colocalizados en el repo pero no entran al tarball npm. `pi.extensions` lista explícitamente los entrypoints que se cargan por defecto; extensiones opcionales pueden existir en la misma convención y cargarse desde settings.

`extensions/pi-local-memory/` carga la carpeta `.pi/memory/` si existe (inyecta el índice `MEMORY.md` con tope de 200 líneas/25 KB y lista los archivos por tema para leerlos on demand; con fallback al `.pi/MEMORY.md` previo). La extensión es parte del paquete; el contenido de memoria sigue siendo privado y gitignored.

## Verificación local

```bash
npm test
```

El gate `npm test` corre, en orden: `tsc` (typecheck de todas las extensiones), `biome check .` (lint + formato de JS/TS/JSON), `markdownlint-cli2` (Markdown) y las suites de integración colocalizadas vía `scripts/test/run-all.mjs`. Biome reemplaza a ESLint + Prettier; los tipos siguen verificándose con `tsc` (Biome no sustituye al type-checker). Para smoke runtime sin gastar subagentes, crea un workflow que use `ctx.parallel`, `ctx.pipeline`, `ctx.bash` y `ctx.writeArtifact`; en sesión TUI/RPC ejecútalo con `dynamic_workflow action=start` (o `action=run`, que también va a background) + `action=view`. En print/json, `action=run` sigue siendo el fallback foreground.

## `/bg` jobs locales

`/bg` provee un runner local mínimo para comandos humanos en background:

```text
/bg preview npm test
/bg start npm test
/bg list
/bg status <jobId>
/bg logs <jobId>
/bg events <jobId>
/bg cancel <jobId>
/bg delete <jobId>
/bg prune [--yes]
```

`/bg` es el primo pequeño de `dynamic_workflow`: este último journaliza y permite `resume`; `/bg` es solo-humano, in-memory y **no resumible**. Usa `/bg` para comandos sueltos en background y `dynamic_workflow` para orquestación agentic.

Comportamiento y límites de M2:

- `/bg start` solo funciona en sesiones persistentes TUI/RPC y en proyectos trusted; en proyectos untrusted se rechaza antes de ejecutar o escribir artifacts. El trust/mode gate protege el **contexto y los artifacts** del proyecto, no el comando en sí: igual que el resto de exec en Pi, `/bg start` corre vía `shell:true` lo que el humano teclee.
- `/bg start` y `/bg cancel` se bloquean mientras `/plan` está activo.
- No se registra ningún tool LLM `background_job`; la superficie mutante es solo slash command humano.
- `/bg events <jobId>` muestra el tail acotado del journal `events.jsonl` (start/running/cancel-*/finish/reconcile-interrupted/finalize-error): la evidencia de *por qué* un job acabó `failed`/`cancelled`/`interrupted`, que `status.json` por sí solo no lleva.
- Los artifacts project-local viven en `.pi/bg/runs/<jobId>/`; el fallback global de lectura usa `~/.pi/agent/bg/runs/<hash-del-cwd>/<jobId>/` (en M2 ese root global solo se **lee**: lo poblará BG-1/BG-3). Cada run contiene `job.json`, `status.json`, `events.jsonl`, `stdout.log`, `stderr.log`, `combined.log`.
- `job.json` y `status.json` se escriben con temp file + rename atómico; los logs son append-only y `/bg logs` lee de forma bounded/truncada.
- El comando (`job.json`) y su salida (`stdout/stderr/combined.log`) se guardan en **texto plano** y no se redactan: evita pasar secretos en la línea de comando (p. ej. tokens en `curl -H`).
- `/bg delete <jobId>` (uno) y `/bg prune` (masivo) recuperan espacio de forma segura: borran **solo** jobs terminados — el estado live se re-deriva al podar, así que un job corriendo, activo en la sesión o huérfano verificado-vivo nunca se borra; actúan solo sobre el store project-local (los globales son de solo lectura); son symlink/path-safe (un symlink interno se desvincula, no se sigue); y registran una línea por borrado en `.pi/bg/runs/.audit.jsonl`. `/bg prune` es un preview dry-run salvo que pases `--yes`.
- `/bg cancel` cancela jobs activos de este proceso Pi y, para un job persistido por otra sesión, señaliza el grupo **solo** si la identidad de inicio verifica que el PID vivo sigue siendo ese job. Para un `status.json` que dice `running`/`starting` pero no es propiedad de esta sesión, el estado se proyecta en tiempo de lectura sondeando el PID registrado (`process.kill(pid, 0)`, sin enviar señal): **`orphaned`** = el PID sigue vivo (proceso huérfano probablemente activo; usa herramientas del SO `kill`/`pkill`/`taskkill` para pararlo), **`interrupted`** = el PID está muerto (Pi murió/reinició antes de finalizar), **`stale`** = no se pudo sondear (sin PID). El sondeo base es best-effort (un PID puede haberse reusado). Para vencerlo, cada job registra una **identidad de inicio** (`startId`: Linux `/proc`, macOS/BSD `ps -o lstart=`, ausente en Windows) y `/bg status` hace una verificación extra: si la identidad coincide es un `orphaned` verificado (`identity: verified`); si difiere, el PID fue reusado y se reporta `interrupted` (`interruptedCause: pid-reused`); si no se puede leer, queda `orphaned` best-effort con `hint`. `/bg list` se queda con el sondeo barato (sin subproceso por job), así que puede mostrar un `orphaned` que `/bg status` refinaría. Un huérfano verificado (`identity: verified`) puede pararse con `/bg cancel` (envía `SIGTERM` al grupo y lo reescribe a `cancelled`, razón `cancel-verified-orphan`); un PID reusado o no verificable se rechaza y nunca se señaliza. La cancelación de jobs activos señaliza por grupo de proceso y, en la ventana exit→close, podría no señalar un PID ya reapeado.
- Al arrancar una sesión persistente y trusted, `pi-bg` se auto-cura: un job project-local persistido como `running`/`starting` cuyo PID está muerto **o vivo-pero-reusado (identidad de inicio distinta)** se reescribe atómicamente a `interrupted` en disco (así el artefacto deja de decir `running` para siempre). Los de PID verificado-vivo o no sondeable quedan intactos (se siguen proyectando como `orphaned`/`stale`). Terminalizar solo con evidencia positiva (PID muerto o reuso probado) mantiene la reescritura segura.
- No hay runner Supacode, daemon, rehidratación automática ni dashboard de `/bg` en M2.

## Background runs

En una sesión persistente TUI/RPC, todos los workflows se lanzan en background por defecto (`run`, `start` y `resume`):

```text
/workflow start bug-hunt-repo-audit {"maxFiles":40,"concurrency":4,"maxAgents":20}
/workflow runs
/workflow view <runId>
/workflow cancel <runId>
```

Desde el tool del modelo:

```json
{ "action": "start", "name": "bug-hunt-repo-audit", "input": { "maxFiles": 40 }, "concurrency": 4, "maxAgents": 20 }
```

Notas:

- `run`/`start` devuelven inmediatamente `runId`, `status.json` y directorio de artifacts en TUI/RPC.
- Al completar o fallar, el background workflow despierta al agente con un follow-up automático para inspeccionar `dynamic_workflow action=view name=<runId>` y continuar la tarea.
- El run continúa solo mientras viva la sesión actual de Pi; al reiniciar, un run incompleto se ve como `stale`. Puedes reanudarlo con `/workflow resume <runId>` (ver "Runs reanudables").
- Monitorea con `/workflow runs`, `/workflow view <runId>` o el tab `Monitor` del dashboard; cancela con `/workflow cancel <runId>` o `dynamic_workflow action=cancel` (el dashboard solo cancela runs activos en esta sesión).
- Sigue gastando llamadas/modelos en background: usa límites explícitos.

## Runs reanudables (idempotentes)

Cuando un run queda interrumpido (la sesión de Pi murió y queda `stale`, o terminó como `failed`/`cancelled`), puedes reanudarlo sin volver a ejecutar los subagentes ya completados (cada subagente es un `pi -p`, caro):

```text
/workflow resume latest              # background por defecto en TUI/RPC
/workflow resume <runId>              # background por defecto en TUI/RPC
/workflow resume <runId> --force       # incluso si el run ya está completed
```

Desde el tool del modelo:

```json
{ "action": "resume", "name": "<runId>", "force": false }
```

Cómo funciona:

- El run se reanuda **in-place**: mismo `runId` y mismo directorio. Estados reanudables: `stale`, `failed`, `cancelled`. Un run `completed` requiere `force:true`.
- Cada run mantiene un `journal.jsonl` host-side con las llamadas completadas. La clave de caché es **content-address**: `sha256(method + args normalizados)`, con un contador de ocurrencia por clave; es correcta bajo concurrencia (`ctx.agents`) porque no depende de ids host-side no deterministas.
- `ctx.agent()` se cachea **por defecto**; desactívalo por llamada con `ctx.agent(prompt, { cache: false })`.
- Para no filtrar secretos, la caché registra solo nombres de `keys` y `env` redactado (`[set]`), no valores; si el resultado depende del valor exacto/rotado de una credencial, usa `{ cache: false }`.
- `ctx.bash()` se cachea solo **opt-in** con `ctx.bash(cmd, { cache: true })` (úsalo únicamente para comandos deterministas, sin efectos secundarios relevantes).
- `ctx.writeArtifact`/`ctx.writeFile` no se cachean: se re-ejecutan, y reescribir es idempotente. `ctx.log`/`ctx.sleep` nunca se cachean.
- Una llamada cacheada (HIT) **no** gasta `pi -p` ni cuenta contra `maxAgents`.
- Una llamada que estaba **en vuelo** cuando murió la sesión no tiene record en el journal: se re-ejecuta (coste: 1 llamada). Una llamada ya completada nunca se duplica.
- **Determinismo**: el cache de una llamada depende exactamente de sus argumentos. Si construyes el prompt o el comando con `Date.now()` o `Math.random()`, esa llamada cambia de argumentos en cada intento y se re-ejecuta al reanudar (cache miss). Es una degradación segura: nunca devuelve un resultado incorrecto, solo re-corre.
- Se guarda un `codeHash` del workflow (sobre el código transformado) en `status.json`/`result.json` y en cada record del journal. Si el código del workflow cambió desde el run original, `/workflow view` y el resume avisan: las llamadas cuyos argumentos cambiaron se re-ejecutan (miss); las que no, siguen cacheadas.
- `/workflow runs` marca los runs reanudables con `resumable` y muestra `cached:N`; `/workflow view <runId>` añade una línea `Resume: /workflow resume <runId>`, el `codeHash`, el número de llamadas cacheadas y el aviso si el código cambió.
- Atomicidad: `status.json`/`result.json` se escriben con temp+rename para no quedar corruptos ante un crash.

## Ejemplo mínimo

```js
function chooseConcurrency(ctx, input, items) {
  if (Number.isFinite(input?.concurrency)) {
    return Math.min(Math.max(Math.floor(input.concurrency), 1), ctx.limits.concurrency, items.length);
  }
  return Math.min(items.length <= 2 ? items.length : 4, ctx.limits.concurrency);
}

export default async function workflow(ctx, input) {
  await ctx.log("start", { input });

  const items = [
    { name: "a", prompt: "Review src/a.ts", tools: ["read", "grep", "find", "ls"], agentType: "reviewer" },
    { name: "b", prompt: "Review src/b.ts", tools: ["read", "grep", "find", "ls"], agentType: "reviewer" },
  ];
  const concurrency = chooseConcurrency(ctx, input, items);
  await ctx.log("fan-out selected", { items: items.length, concurrency });

  const reviews = await ctx.agents(items, { concurrency, settle: true });
  const completedReviews = reviews.filter(Boolean);
  await ctx.log("review fan-out complete", { total: reviews.length, failed: reviews.length - completedReviews.length });

  await ctx.writeArtifact("reviews.json", reviews);
  return ctx.compact(completedReviews, 20000);
}
```

## Concurrencia: por qué el default es 4

`concurrency` controla cuántos subagentes pueden estar ejecutando `pi -p` al mismo tiempo. No es la cantidad total de trabajo: un bug hunt de 40 archivos con `concurrency: 4` corre en tandas de hasta 4 agentes simultáneos hasta completar la lista.

El default es `4` porque es un punto seguro entre velocidad, coste y estabilidad:

- **Acelera sin explotar el presupuesto**: 4 llamadas concurrentes ya reducen mucho el wall-clock frente a ejecución serial, pero no multiplica agresivamente coste instantáneo, rate limits o ruido.
- **Protege al provider y a la máquina local**: cada subagente es un proceso `pi -p --no-session --mode json`; demasiados procesos/model calls a la vez pueden saturar CPU, I/O, terminales, logs o límites del proveedor.
- **Reduce fallas correlacionadas**: con fan-out grande, subir demasiado la concurrencia aumenta timeouts, rate-limit errors y ramas fallidas. `4` suele ser estable para auditorías/research read-only.
- **Mantiene buena observabilidad**: logs, artifacts y dashboard siguen siendo legibles; 12–16 ramas simultáneas pueden producir eventos difíciles de seguir.
- **Es conservador por defecto, no una recomendación fija**: workflows largos deben pasar límites explícitos según tarea, modelo y presupuesto.

Límites relacionados:

- `concurrency` = máximo de subagentes simultáneos.
- `maxAgents` = máximo total de subagentes del run.
- `maxFiles`, `angles`, `rounds`, etc. = límites propios del workflow sobre la lista de trabajo.
- Hard cap actual: `concurrency` se normaliza entre `1` y `16`; si no se pasa nada, queda en `4`.

### La concurrencia debe ser dinámica

Que el default sea `4` **no significa que los workflows deban hardcodear 4**. Los workflows son dinámicos: primero hacen scout, descubren la lista real de trabajo y recién ahí eligen cuánto paralelismo usar.

La decisión queda en capas:

- **Usuario/agente al lanzar el run**: puede pasar `concurrency` explícita si conoce presupuesto, provider o urgencia.
- **Runtime**: impone el límite efectivo (`ctx.limits.concurrency`) y el hard cap global para evitar valores peligrosos.
- **Workflow**: decide una concurrencia local según cantidad de items, riesgo, coste y tipo de tarea, sin superar `ctx.limits.concurrency`.

Criterios para elegir dinámicamente:

- **Tamaño de la work-list**: si hay 1–2 items, usar 1–2; si hay decenas, puede subir.
- **Tipo de tarea**: auditoría read-only tolera más paralelismo; tareas con escritura, migración o efectos secundarios deben ser más conservadoras.
- **Coste/modelo/provider**: modelos caros o rate limits estrictos bajan la concurrencia.
- **Profundidad pedida**: “quick check” usa menos; “auditá exhaustivamente” puede usar más, con `maxAgents` explícito.
- **Modo background**: puede correr más tiempo, pero no debería gastar agresivamente sin límites visibles.

Ejemplo de selección dinámica:

```js
function chooseConcurrency(ctx, input, items, opts = {}) {
  if (Number.isFinite(input?.concurrency)) {
    return Math.min(Math.max(Math.floor(input.concurrency), 1), ctx.limits.concurrency);
  }

  const count = items.length;
  if (count <= 1) return 1;
  if (opts.sideEffects) return Math.min(2, count, ctx.limits.concurrency);
  if (opts.expensiveModel) return Math.min(2, count, ctx.limits.concurrency);
  if (opts.readOnlyAudit && count >= 30) return Math.min(8, count, ctx.limits.concurrency);
  return Math.min(4, count, ctx.limits.concurrency);
}
```

El default `4` es solo el fallback seguro cuando nadie dio una señal mejor. Un workflow bien diseñado debe poder bajar a `1–2` o subir a `6–8` según lo que descubrió.

Cómo se aplica:

```js
const concurrency = Math.min(
  input?.concurrency ?? ctx.limits.concurrency,
  ctx.limits.concurrency,
);

const reviews = await ctx.agents(items, { concurrency, settle: true });
```

- `ctx.limits.concurrency` es el límite efectivo del run y es read-only.
- `ctx.agents(..., { concurrency })` además lo vuelve a clamplear para no superar el límite del run.
- `ctx.pipeline()` y `ctx.parallel()` también usan `ctx.limits.concurrency` como límite local.
- Las llamadas cacheadas al reanudar (`journal.jsonl` HIT) no ejecutan `pi -p`, por lo tanto no consumen slots de concurrencia ni cuentan contra `maxAgents`.

Regla práctica:

- Usa `1–2` para modelos caros, rate limits estrictos, debugging o workflows con efectos secundarios.
- Usa `4` como default seguro para revisión/research read-only.
- Usa `6–8` si hay muchas ramas independientes y el provider responde bien.
- Usa `12–16` solo para barridos grandes, read-only, con `maxAgents` y timeout explícitos.

## API del workflow

- `ctx.agent(prompt, opts)` — ejecuta un subagente Pi (`pi -p --no-session`). Se cachea por defecto para resume; desactívalo con `{ cache: false }`. Usa `tools`/`excludeTools`, `skills`/`includeSkills`, `extensions`/`includeExtensions` y `keys`/`env` para definir accesos por agente.
- `ctx.agent(prompt, { schema })` — pide JSON validado; devuelve `result.data` y `result.schemaOk` (reintenta con `schemaRetries`, default `2`).
- `ctx.agent(prompt, { agentType: "reviewer" })` — aplica defaults de persona (`explore`, `reviewer`, `planner`, `implementer`, `researcher`); las opciones explícitas ganan.
- `ctx.agents(items, opts)` — ejecuta muchos subagentes con concurrencia limitada.
- `ctx.agents(items, { concurrency, settle: true })` — devuelve `Array<SubagentResult | null>`: los fallos de ramas individuales son `null`, las demás ramas siguen.
- `ctx.pipeline(items, ...stages)` — flujo multi-etapa por item sin barrera global; cada stage recibe `(prev, item, index)` y los items fallidos devuelven `null`.
- `ctx.parallel([async () => ...])` — ejecuta thunks async con barrera y concurrencia local limitada; cada thunk fallido produce `null`. Usalo solo cuando un paso posterior necesita todos los resultados juntos.
- `ctx.workflow(name, input)` — ejecuta un sub-workflow reusable inline dentro del mismo run (profundidad 1). Comparte `runDir`, `maxAgents`, concurrencia, abort y journal/cache; emite eventos `workflow` para auditabilidad. Úsalo para librerías como `lib/verify-claims`, no para fases que requieren una decisión humana entre medio.
- `ctx.bash(command, opts)` — ejecuta shell. Opt-in al cache de resume con `{ cache: true }` (solo comandos deterministas).
- `ctx.readFile/writeFile/appendFile/listFiles` — helpers de archivos confinados al cwd del workflow.
- `ctx.writeArtifact/appendArtifact` — persiste datos en el directorio del run (idempotente; no se cachea, se reescribe al reanudar).
- `ctx.log` — progreso visible y `events.jsonl`.
- `ctx.compact(value, maxChars)` — serializa y trunca resultados grandes.
- `ctx.json(value, maxChars)` — alias de `compact` (misma serialización/truncado).
- `ctx.limits` — límites efectivos del run (`concurrency`, `maxAgents`, timeouts); es read-only.

Opciones habituales de subagente:

```js
{
  name: "review-auth",
  tools: ["read", "grep", "find", "ls"],
  skills: ["/path/to/skill"],
  extensions: ["/path/to/extension.ts"],
  keys: ["GITHUB_TOKEN"], // valores redacted; missing keys quedan visibles en dashboard/artifacts
  timeoutMs: 300000,
  thinking: "high",
  agentType: "reviewer",
  schema: { type: "object", required: ["verdict"], properties: { verdict: { type: "string" } } },
  schemaOnInvalid: "throw"
}
```

## Patrones de prompts recomendados

Los workflows funcionan mejor cuando cada prompt declara explícitamente el patrón:

- **Fan-out independiente**: cada subagente debe producir un reporte útil aunque otros fallen.
- **Contrato de evidencia**: pedir archivo/línea, URL, comando observado o `INSUFFICIENT_EVIDENCE` / `NO_FINDINGS`.
- **Formato fijo**: preferí `ctx.agent(prompt, { schema })` para JSON; si no, secciones `Veredicto`, `Hallazgos`, `Evidencia`, `Riesgos`, `Fix`, `Verificación`.
- **Synthesis-as-judge**: el agente final deduplica, descarta claims sin evidencia, preserva incertidumbre y elige una ruta concreta.
- **Crítica adversarial**: reviewers con objetivo explícito de encontrar edge cases, reducir scope y marcar riesgos aceptados.
- **Fallas parciales visibles**: la síntesis debe mencionar agentes fallidos, vacíos, cancelados o con timeout.
- **Seguridad por defecto**: en auditorías, prompts con “no edites archivos”, tools read-only, solo las `skills`/`extensions` requeridas y solo las `keys` que esa rama necesita.

## Seguridad y coste

**Workflows son código confiable, no un sandbox de seguridad.** Pueden ejecutar JavaScript, usar `fetch`, llamar `ctx.bash`, leer/escribir archivos del cwd y disparar muchas llamadas a modelos mediante subagentes.

Buenas prácticas:

- Usa límites explícitos: `concurrency`, `maxAgents`, `timeoutMs`, `agentTimeoutMs`.
- Para auditorías, limita subagentes a tools read-only: `tools: ["read", "grep", "find", "ls", "web_search"]`.
- Por defecto, los subagentes intentan tener búsqueda web (`pi-codex-web-search` + `web_search`) y Context7 (`context7-cli`) disponibles; podés desactivarlos con `includeExtensions: false` / `excludeTools: ["web_search"]` y `includeSkills: false`.
- Para skills/extensiones adicionales, usa `skills: ["ruta"]` y `extensions: ["ruta.ts"]` por agente. Si pasas listas explícitas, Pi desactiva discovery para ese tipo salvo que marques `includeSkills: true` o `includeExtensions: true`.
- Para credenciales, usa `keys: ["ENV_VAR"]` por agente; si `keys` está presente, el subagente corre con env aislado + esas keys. `env: { NAME: "value" }` también existe, pero evita literales secretos en código.
- Evita `bash` salvo que el workflow realmente lo necesite.
- Revisa workflows antes de ejecutarlos, especialmente si vienen de terceros.

Para ver los scaffolds disponibles, usá `/workflow patterns` o `dynamic_workflow action=template`; los runs reales deberían crear workflows task-specific dinámicamente.
