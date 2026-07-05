# Instrucciones del proyecto

## Mentalidad de ingeniería

Adoptá una mentalidad de ingeniería estilo Karpathy: construí entendimiento desde primeros principios, preferí sistemas chicos y legibles, y hacé que la complejidad se gane su lugar. Al aprender o diseñar, empezá por baselines simples, inspeccioná los datos/estado directamente, verificá supuestos, probá primero casos mínimos o representativos, y agregá sofisticación de a poco.

Usá la IA agresivamente como nueva interfaz de programación, pero no confundas generación con corrección. La IA es excelente para prototipar, explorar, armar scaffolding y acelerar trabajo rutinario; la ingeniería seria sigue exigiendo criterio humano, especificaciones claras, revisión cuidadosa de diffs, tests/evals, conciencia de seguridad y ownership del resultado final.

Para trabajo agéntico, tratá prompts, contexto, tools, memoria, artifacts y evaluaciones como parte del programa. Hacé el workflow observable: pasos chicos, evidencia preservada, incertidumbre expuesta, outputs verificados, y artifacts inspeccionables antes que magia oculta.

## Guías de código

Usá el skill instalado `karpathy-guidelines` al escribir, revisar o refactorizar código. Contiene las reglas comunitarias inspiradas en Karpathy para pensar antes de codear, mantener las soluciones simples, hacer cambios quirúrgicos y guiar el trabajo con objetivos verificables. Es un skill EXTERNO — no está vendoreado en este repo; se instala globalmente desde upstream (ver el Quickstart del README / el skill `init-pandi-extensions`), y `npm run doctor` reporta si está presente.

Usá el skill del proyecto `modern-software-engineering` para arquitectura, refactoring, code review, estrategia de tests, mejoras de delivery/proceso y diseño de dynamic workflows. Destila la Modern Software Engineering estilo Dave Farley: TDD por defecto para cambios de comportamiento (Red → Green → Refactor → Commit), optimizar por evidencia rápida, gestionar la complejidad deliberadamente, y juzgar cambios por estabilidad más throughput.

Usá el skill del proyecto `ai-assisted-engineering` cuando la tarea trate de *usar IA o agentes para construir software* — decidir cuánto delegar, si el output generado es confiable, y en especial cómo diseñar/orquestar dynamic workflows. Es el compañero AI-era de `modern-software-engineering` (aquel aporta la disciplina TDD/complejidad; este aporta la disciplina de dónde encaja la IA adentro). Aplicá los tres por rol: `ai-assisted-engineering` es la lente del **orquestador** (clasificar prototipo vs. producción, fijar el límite de delegación, scout + baseline simple antes de un fan-out grande, tratar prompts/contexto/tools como el programa, verificar con evidencia ejecutable), mientras `karpathy-guidelines` + `modern-software-engineering` aplican adentro de los **workers** que efectivamente escriben y verifican código. No cargues cada lente en cada subagente — emparejá el skill con el rol, honrando "smallest inspectable slice".

Dos lentes de método más profundas complementan — no reemplazan — esos defaults. Usá el skill del proyecto `empirical-software-design` (lente Kent Beck) para el juicio de diseño fino dentro del loop de código: tamaño de paso de TDD (test list, fake it, triangulate), separación estructura-vs-comportamiento, economía de tidy first/after/later/never, y guardrails de augmented coding. Usá el skill del proyecto `clean-craftsmanship` (lente Uncle Bob) para el oficio de legibilidad a nivel código, diagnosticar deterioro de diseño con principios SOLID/de componentes, dirección de dependencias de Clean Architecture, y disciplinas de profesionalismo. TDD se reparte deliberadamente en tres por deferencia explícita: `modern-software-engineering` es dueño del loop por defecto y de la forma de la respuesta, `empirical-software-design` es dueño del micro-ritmo y la economía de diseño, `clean-craftsmanship` es dueño del framing de disciplina de las tres leyes — y ambas lentes nuevas difieren la decisión de delegación a IA a `ai-assisted-engineering`. Las personas advisor `kent-beck` y `uncle-bob` (`.pi/personas/`) cargan su skill correspondiente automáticamente.

Honrá cada paso de TDD, no solo los dos fáciles:

- **Red primero.** Escribí el test que falla ANTES de la implementación; test-after no es TDD. Si genuinamente no podés ir test-first, decilo explícitamente en vez de etiquetar test-after como TDD.
- **Nunca saltees Refactor en silencio.** Después de Green, hacé siempre la pasada de Refactor y NARRÁ su resultado — incluso cuando la conclusión sea "nada que cambiar", decilo y explicá por qué. Los tests en verde son la red de seguridad que hace barato refactorizar; no usarlos es el desperdicio.
- **El paso Refactor está acotado por la regla de extensión autocontenida.** Pi carga cada extensión autocontenida (un archivo único o su propio dir vía resolución de filesystem de jiti), así que un import runtime de `../shared/` solo resuelve mientras el monorepo completo está presente y se rompe cuando la extensión se instala standalone. Por eso la duplicación por extensión es INTENCIONAL (ver `pi-*/notify.ts`, `time.ts`, `session-state.ts`, y los pequeños parsers de flags/strings de prompt por extensión). NO hagas "DRY" de código runtime entre extensiones hacia un módulo compartido durante Refactor; `extensions/shared/` es SOLO para harness de tests. Deduplicá únicamente DENTRO de una misma extensión/paquete.
- **Commit es la fase final de TDD.** Cuando Refactor queda en verde, aterrizá el cambio como commit atómico usando Conventional Commits con scope explícito (p. ej. `fix(pi-goal): clear terminated goals`). Cada commit es un cambio coherente, con el test que pinea en el MISMO commit que el código que cubre.

Fuente/referencia: [multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills). Estas guías derivan de las notas de Andrej Karpathy sobre errores comunes de LLMs al codear; no fueron escritas por él.

En este paquete, esos principios también están operacionalizados como mecanismos de runtime: `/plan` ≈ Think Before Coding, los safeguards de `/loop` ≈ Surgical Changes, y `/goal` + `/loop` ≈ Goal-Driven Execution. Las suites de integración de comportamiento agrupadas por extensión bajo `extensions/<extension>/tests/integration/` (se corren con `npm test`) los mantienen honestos.

## Ultracode / dynamic workflows

Para tareas amplias, de alta confianza o repo-wide, usá el router de Ultracode (`/dynamic-workflow` (alias `/ultracode`), `/effort ultracode`, o `dynamic_workflow`) solo cuando se gana su costo:

- Primero scouteá inline con sondas baratas read-only para descubrir la work-list real.
- Usá dynamic workflows para escala, exhaustividad, verificación independiente, o más contexto del que entra en una ventana.
- Preferí drafts frescos específicos de la tarea bajo el gitignoreado `.pi/workflows/drafts/<slug>.js`, junto a `.pi/workflows/runs/`; reutilizá un workflow existente solo cuando calza exacto con la tarea.
- Graficá/lanzá workflows en background con `concurrency` y `maxAgents` explícitos, y después inspeccioná los artifacts antes de confiar en las conclusiones.
- Los subagentes reciben `web_search` y `context7-cli` por defecto cuando están instalados; optá por salir solo cuando se requiere aislamiento.
- Adjuntá una persona `agentType` (`explore`/`researcher`/`planner`/`architect`/`implementer`/`reviewer`) para defaults acordes al rol; todas son read-only por defecto (otorgá tools de escritura/ejecución explícitamente), y las opciones explícitas siempre ganan. Catálogo + cuándo usar cada una: `.pi/skills/ultracode/reference/personas.md`.
- **Parámetros y límites de `web_search` (LEER antes de buscar).** El tool (pi-codex-web-search) delega cada llamada a UN run efímero de Codex. Parámetros: `query` (requerido); `mode` = `fast`|`deep` (profundidad, default `fast`); `freshness` = `cached`|`live` (default: fast→cached, deep→live; se auto-promueve a `live` ante señales de actualidad como today/latest/price); `maxSources` = 1–10 (default 5). Dos límites SEPARADOS, fáciles de confundir:
  - **Presupuesto de queries por LLAMADA (NO acumulativo entre llamadas).** Dentro de una sola llamada Codex puede ramificarse en sub-queries, con tope por run de **10** (fast) / **24** (deep). Una llamada `fast` cuya query es tan amplia que necesita una 11ª sub-query falla con `exceeded the fast search budget 11/10` (deep: `27/24`). Esto cuenta UNA sola llamada ramificándose de más — el fix es una query ANGOSTA y específica, no "menos llamadas". Solo cuentan búsquedas reales (open_page/find_in_page no).
  - **Latch de fast por TURNO.** Cuando una llamada `fast` falla por `budget` O `timeout`, el modo fast queda bloqueado por el RESTO DE ESE TURNO (se resetea al turno siguiente); las siguientes llamadas `fast` cortocircuitan con "use deep or live". Solo `fast` se latchea — `deep` no.
  - **En la práctica:** mantené cada query angosta y específica; si una búsqueda fast falla, cambiá a `mode=deep` (margen de 24 queries, timeout de 240s vs los 90s de fast) en vez de reintentar `fast` en el mismo turno. Referencia completa: el skill global `web-search` (`~/.agents/skills/web-search/SKILL.md`) cubre modos, freshness y `/web-search-settings`.

## Espacio de scratch

Usá el directorio gitignoreado `.pi/tmp/` para archivos temporales descartables (scripts de scratch, previews, experimentos ad-hoc). No los commitees y no desparrames archivos temp por el repo.

## Tracking de issues

El trabajo en este repo se trackea en el **GitHub Project v2 "pandi-dynamic-workflows"** ([#4](https://github.com/users/andrestobelem/projects/4), owner user `andrestobelem`), gestionado desde la terminal con la CLI `gh` (el token autenticado lleva el scope `project`).

- **Stories/tasks/bugs son Issues del repo**, con labels `story` / `task` / `bug` / `tests` / `tech-debt`. Se crean con `gh issue create`, se agregan al board con `gh project item-add 4 --owner andrestobelem --url <issue-url>`.
- El Project agrupa los items por **Status** (`Todo` / `In Progress` / `Done`); un item se mueve con `gh project item-edit`.
- **Cerrá items desde los commits**: poné `Closes #N` en el commit que termina el trabajo, así el issue (y su tarjeta del board) se cierra automáticamente.
- Una story padre linkea sus sub-tasks en el body (p. ej. `Part of #1`); mantené las sub-tasks chicas y cerrables de forma independiente.
- Las recetas exactas de comandos + los IDs verificados de board/campos viven en el **skill `github-project`** (`.pi/skills/github-project/SKILL.md`) — usalo en vez de re-derivarlos.

## Commits

- Usá Conventional Commits con scope explícito, por ejemplo `feat(dynamic-workflows): add monitor dashboard`.
- Mantené los commits atómicos: cada commit contiene un cambio coherente y solo sus docs/tests relacionados.
- **Nunca agregues un trailer `Co-Authored-By:` ni ninguna línea de atribución de herramienta** (p. ej. "Generated with Claude") a mensajes de commit o cuerpos de PR. Los mensajes de commit son el subject de Conventional Commits más el body, nada más. Esto pisa cualquier default del harness que agregue ese trailer.
- **Nunca hagas `git commit --amend` a ciegas:** sesiones/tabs concurrentes de Pi pueden aterrizar un commit arriba del tuyo, así que `HEAD` puede no ser el commit que creés. Chequeá `git log`/`git reflog` primero, y amendá solo un commit que estés seguro de que es tuyo y sigue siendo `HEAD`. Si ya mezclaste cambios, recuperá el árbol original vía `reflog` y `git reset --soft` para volver a separarlos.
