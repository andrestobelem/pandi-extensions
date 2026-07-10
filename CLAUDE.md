# Instrucciones del proyecto

## En 30 segundos

Este repo es **pandi-extensions**: una suite de extensiones, skills, tema y workflows para convertir Pi en un laboratorio de patrones agénticos ejecutables. Este archivo es la guía raíz para agentes: define cómo pensar, cuándo delegar, cómo verificar y qué límites no cruzar.

Leé primero el estado real del repo, hacé cambios chicos, verificá con evidencia y dejá el trabajo observable. Menos magia, más bambú inspeccionable. 🐼

> **Fuente canónica:** editá `AGENTS.md`. `CLAUDE.md` es un espejo byte-idéntico para Claude Code; después de tocar esta guía corré `node scripts/sync-agent-guides.mjs`.

## Loop de trabajo esperado

1. **Scout primero.** Mirá `git status`, leé los archivos relevantes y comprobá supuestos con comandos baratos antes de diseñar.
2. **Elegí el paso más chico que aprenda algo.** Preferí una corrección quirúrgica con evidencia rápida a un refactor amplio sin necesidad.
3. **Si cambia comportamiento, TDD por defecto.** Red → Green → Refactor → Commit. Si no podés ir test-first, decilo explícitamente; no llames TDD a test-after.
4. **Refactor no se saltea en silencio.** Después de Green, hacé la pasada de Refactor y narrá el resultado, incluso si es “nada que cambiar”.
5. **Verificá lo tocado.** Usá tests/checks acotados primero; corré gates amplios solo cuando el alcance lo justifique y el árbol no tenga cambios ajenos que contaminen el resultado.
6. **Preservá trabajo ajeno.** En un repo con sesiones concurrentes, nunca limpies, formatees, agregues al stage, resetees ni commitees archivos que no pertenecen a tu tarea.

## Lectura de archivos grandes

Cuando uses herramientas tipo `Read`/`read` sobre código, logs o docs grandes, tratá la lectura como una búsqueda guiada, no como un `cat` gigante:

1. **Scout antes de leer.** Usá `rg`, `git ls-files`, glob/diff o una lectura focalizada para ubicar zonas relevantes.
2. **Usá la lectura completa solo como probe.** Si devuelve salida parcial/truncada, no repitas igual: continuá por ventanas.
3. **Paginá con `offset` + `limit`.** Leé ventanas acotadas (p. ej. 300–500 líneas) y avanzá con el offset según las líneas devueltas.
4. **Solapá ventanas de código.** Superponé ~20–50 líneas para no cortar funciones/clases.
5. **Achicá en archivos densos.** JSON minificado, bundles, stack traces o líneas larguísimas pueden desbordar tokens con pocas líneas; bajá `limit` o extraé con `rg`/comando focalizado.
6. **Subí límites solo como último recurso.** En Claude Code, `Read` está limitado por tokens: `PARTIAL view` indica continuar con `offset`/`limit`, y una lectura con offset/limit que aún excede el límite falla. `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` existe, pero no reemplaza leer dirigido.

Para workflows/subagentes, dividí inputs enormes en chunks semánticos y usá `agents()`/`pipeline()`/`map-reduce` en vez de meter un archivo grande entero en un prompt.

## Mentalidad de ingeniería

Adoptá una mentalidad de ingeniería estilo Karpathy: construí entendimiento desde primeros principios, preferí sistemas chicos y legibles, y hacé que la complejidad se gane su lugar. Al aprender o diseñar, empezá por baselines simples, inspeccioná los datos/estado directamente, verificá supuestos, probá primero casos mínimos o representativos, y agregá sofisticación de a poco.

Usá la IA agresivamente como nueva interfaz de programación, pero no confundas generación con corrección. La IA es excelente para prototipar, explorar, armar scaffolding y acelerar trabajo rutinario; la ingeniería seria sigue exigiendo criterio humano, especificaciones claras, revisión cuidadosa de diffs, tests/evals, conciencia de seguridad y ownership del resultado final.

Para trabajo agéntico, tratá prompts, contexto, tools, memoria, artifacts y evaluaciones como parte del programa. Hacé el workflow observable: pasos chicos, evidencia preservada, incertidumbre expuesta, outputs verificados, y artifacts inspeccionables antes que magia oculta.

## Skills y lentes de diseño

Usá estos skills cuando el trabajo toque su dominio:

| Skill | Cuándo usarlo |
| --- | --- |
| `karpathy-guidelines` | Escribir, revisar o refactorizar código con cambios simples, quirúrgicos y verificables. Es externo; `npm run doctor` reporta si está instalado. |
| `modern-software-engineering` | Arquitectura, refactoring, code review, tests, delivery y diseño de dynamic workflows. Es el dueño del loop TDD por defecto. |
| `ai-assisted-engineering` | Decidir cuánto delegar a IA/agentes y cómo diseñar/orquestar dynamic workflows. Es la lente del **orquestador**. |
| `empirical-software-design` | Micro-ritmo de TDD, tamaño de paso, fake/triangulate, tidy first/after/later/never y reversibilidad. |
| `clean-craftsmanship` | Legibilidad, SOLID/componentes, Clean Architecture, dependencia y disciplina profesional. |

Aplicá cada lente donde aporta: `ai-assisted-engineering` para el orquestador; `karpathy-guidelines` + `modern-software-engineering` para workers que escriben/verifican código; `empirical-software-design` para el ritmo fino; `clean-craftsmanship` para oficio y límites de diseño. Deferencia TDD: `modern-software-engineering` gobierna el loop y la forma de respuesta; `empirical-software-design`, el micro-ritmo y la economía de diseño; `clean-craftsmanship`, la disciplina de las tres leyes y el profesionalismo. Las decisiones de delegación a IA difieren a `ai-assisted-engineering`. Las personas advisor `kent-beck` y `uncle-bob` (`.pi/personas/`) cargan su skill correspondiente automáticamente.

Fuente/referencia: [multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills). Estas guías derivan de notas de Andrej Karpathy sobre errores comunes de LLMs al codear; no fueron escritas por él.

## Reglas de código y arquitectura

- **Extensiones autocontenidas.** Pi carga cada extensión autocontenida (un archivo único o su propio dir vía resolución de filesystem de `jiti`). Un import runtime de `../shared/` solo resuelve mientras el monorepo completo está presente y se rompe cuando la extensión se instala standalone.
- **Duplicación intencional entre extensiones.** La duplicación por extensión es válida para mantener packages publicables por separado (por ejemplo `pandi-*/notify.ts`, `time.ts`, `session-state.ts` y parsers chicos). `extensions/shared/` es SOLO para harness de tests.
- **DRY dentro del paquete.** No dedupes runtime entre extensiones hacia un módulo compartido; sí dedupá dentro de la misma extensión/paquete cuando reduce complejidad real.
- **Pruebas colocalizadas.** Las suites de integración viven bajo `extensions/<extension>/tests/integration/` y se corren con `npm test` o con comandos acotados por extensión.
- **Runtime como mecanismo de disciplina.** En este paquete, `/plan` ≈ Think Before Coding, los safeguards de `/loop` ≈ Surgical Changes, y `/goal` + `/loop` ≈ Goal-Driven Execution.

## Verificación y repo auto-hospedado

Este repo puede estar instalado globalmente apuntando al mismo checkout de trabajo: `/reload` puede cargar TypeScript sin commitear y un error de carga puede tumbar la sesión. Loop seguro:

1. **Primero tests aislados.** Usá suites de integración con el harness (`node --test ...` o `npm test`) antes de smoke tests en vivo.
2. **Smoke en vivo en worktree aparte.** Si necesitás probar comandos Pi reales, abrí una segunda sesión en un worktree (`git_worktree open ...`) y hacé `pi install ./ -l` ahí.
3. **TypeScript con tool dedicado.** Para archivos TypeScript tocados, preferí `typescript_diagnostics` sobre invocar `tsc` a mano.
4. **Markdown tocado.** Para Markdown, corré `npx markdownlint-cli2 ":ruta.md"` o `npm run lint:md` cuando el alcance sea repo-wide.
5. **Gate completo.** `npm test` corre `typecheck`, `biome check .`, `markdownlint-cli2`, checks de sync/docs/personas, unit tests e integración. Usalo antes de cerrar trabajo amplio o cuando el árbol esté bajo control.

## Docs y prosa

- Usá `didactic-docs-style` para documentación: apertura en 30 segundos, disclosure progresivo, tablas/diagramas para decisiones, ejemplos mínimos y exactitud verificable.
- Usá `pandi-prose-style` para ajustar tono por superficie. En docs/READMEs/AGENTS el tono Pandi es visible pero liviano; en prompts, errores y código es cero o casi cero según la matriz.
- Comentarios de código: explicá intención, contrato, invariantes o límites de responsabilidad; no narres lo obvio ni línea por línea. Preferí comentarios breves en español que digan qué se preserva o por qué existe la abstracción.
- `docs/html/` es generado: regeneralo con `npm run sync:docs:html`; no lo edites a mano.
- `CLAUDE.md` también es generado desde `AGENTS.md`: no lo edites a mano salvo que estés probando el guard de parity.

## Ultracode / dynamic workflows

Para tareas amplias, de alta confianza o repo-wide, usá el router de Ultracode (`/dynamic-workflow` alias `/ultracode`, `/effort ultracode`, o `dynamic_workflow`) solo cuando se gana su costo:

| Gate | Decisión |
| --- | --- |
| Trivial | Conversacional, un archivo, o pocos tool calls → hacelo inline. |
| Scout | Si puede ser grande, primero descubrí work-list real con `git ls-files`, `rg`, diff o lectura focalizada. |
| Orquestar | Usá workflow solo por exhaustividad, confianza independiente o escala/contexto. |

Reglas prácticas:

- Preferí drafts específicos bajo `.pi/workflows/drafts/<slug>.js`; reutilizá un workflow existente solo cuando calza exacto.
- Graficá/lanzá workflows en background con `concurrency` y `maxAgents` explícitos; inspeccioná artifacts antes de confiar en conclusiones.
- Logueá todo cap, sample, top-N, clamp o branch fallida. Nunca reduzcas cobertura en silencio.
- Elegí `agent` / `agents` / `pipeline` / `parallel` por dependencia de datos, no por estética. `pipeline` es el default para etapas dependientes por item sin merge global.
- Tratá `model` y `effort` como dos diales independientes. En fan-out ancho fijá `model` explícito; subí `effort` cuando la tarea requiera juicio, ambigüedad o ranking difícil.
- Los subagentes reciben `web_search` y `context7-cli` por defecto cuando están instalados; optá por salir solo si necesitás aislamiento.
- Adjuntá `agentType` (`explore`/`researcher`/`planner`/`architect`/`implementer`/`reviewer`) para defaults de rol. Catálogo de personas: `.pi/skills/ultracode/reference/personas.md`.

### `web_search`: límites importantes

El tool `web_search` (pi-codex-web-search) delega cada llamada a un run efímero de Codex.

- Parámetros: `query`, `mode` = `fast`|`deep`, `freshness` = `cached`|`live`, `maxSources` = 1–10.
- **Presupuesto por llamada, no acumulativo:** dentro de una llamada, Codex puede ramificarse hasta 10 sub-búsquedas en `fast` o 24 en `deep`. Si una query amplia falla con `exceeded the fast search budget 11/10`, hacé la query más angosta o usá `deep`; no es un contador global de la sesión.
- **Latch por turno para `fast`:** si una llamada `fast` falla por budget o timeout, `fast` queda bloqueado por el resto del turno. Cambiá a `deep`/`live` en vez de reintentar `fast`.
- Referencia completa: skill global `web-search` (`~/.agents/skills/web-search/SKILL.md`).

## Espacio de scratch

Usá `.pi/tmp/` para archivos temporales descartables (scripts de scratch, previews, experimentos ad-hoc). No los commitees y no desparrames archivos temp por el repo.

## Tracking de issues

El trabajo se trackea en el **GitHub Project v2 `pandi`** ([#4](https://github.com/users/andrestobelem/projects/4), owner user `andrestobelem`) con issues del repo [`andrestobelem/pandi-extensions`](https://github.com/andrestobelem/pandi-extensions).

- **Stories/tasks/bugs son Issues del repo**, con labels `story` / `task` / `bug` / `tests` / `tech-debt`. Se crean con `gh issue create` y se agregan al board con `gh project item-add 4 --owner andrestobelem --url <issue-url>`.
- El Project agrupa items por **Status** (`Todo` / `In Progress` / `Done`); se mueven con `gh project item-edit`.
- Cerrá items desde commits: poné `Closes #N` en el commit que termina el trabajo para cerrar issue y card automáticamente.
- Una story padre linkea sus sub-tasks en el body (p. ej. `Part of #1`); mantené las sub-tasks chicas e independientemente cerrables.
- Recetas exactas + IDs verificados viven en el skill `github-project` (`.pi/skills/github-project/SKILL.md`); usalo en vez de re-derivar comandos.

## Commits

- Usá Conventional Commits con scope explícito, por ejemplo `docs(agents): refresh root agent guide` o `fix(pandi-goal): clear terminated goals`.
- Mantené commits atómicos: cada commit contiene un cambio coherente y solo sus docs/tests relacionados.
- **Nunca agregues líneas `Co-authored-by:`** (también escritas `Co-Authored-By:`) ni otras de atribución de herramienta (p. ej. “Generated with Claude”) a commits o PRs. El repo no usa atribuciones de coautoría en mensajes de commit; el hook `commit-msg` las rechaza automáticamente.
- **Nunca hagas `git commit --amend` a ciegas.** Chequeá `git log`/`git reflog` primero; sesiones concurrentes pueden haber aterrizado commits arriba del tuyo.
- Si hay cambios ajenos en el árbol, stageá explícitamente solo tus archivos (`git add AGENTS.md CLAUDE.md`, etc.) o no commitees.
