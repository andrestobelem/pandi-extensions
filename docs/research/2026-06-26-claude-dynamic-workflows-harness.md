---
type: "Research Note"
title: "Claude Dynamic Workflows: _A harness for every task_"
description: "Análisis del harness de Dynamic Workflows en Claude Code y comparación con Pi."
tags: [claude-code, dynamic-workflows, harness, orchestration]
timestamp: 2026-06-26T00:00:00Z
---

# Claude Dynamic Workflows: _A harness for every task_

## En 30 segundos

Este informe resume cómo Anthropic presenta los dynamic workflows en Claude Code: una capa de orquestación que saca la estrategia del contexto y la vuelve un script JavaScript ejecutable. Sirven para tareas grandes o inciertas, donde hace falta fan-out, verificación cruzada y estado persistente sin llenar la conversación principal. Si querés comparar esa propuesta con Pi Dynamic Workflows, empezá por la tesis y la sección de comparación.

## Fuentes revisadas

- Anthropic blog: [_A harness for every task: dynamic workflows in Claude Code_](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code), Thariq Shihipar y Sid Bidasaria, 2026-06-02.
- Anthropic blog: [_Introducing dynamic workflows in Claude Code_](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code), 2026-05-28.
- Claude Code docs: [Orchestrate subagents at scale with dynamic workflows](https://code.claude.com/docs/en/workflows).
- Claude Code docs: [Model configuration](https://code.claude.com/docs/en/model-config) para `ultracode`.
- Claude Code docs: [Settings](https://code.claude.com/docs/en/settings) para deshabilitar workflows.
- Claude Code docs: [Glossary](https://code.claude.com/docs/en/glossary) para la definición de agentic harness.
- Claude Code changelog: v2.1.154 introduce dynamic workflows.
- InfoQ: cobertura independiente del lanzamiento de Dynamic Workflows.

## Tesis del post

El punto central de _A harness for every task_ es que, para tareas grandes o inciertas, el agente no debería intentar coordinar todo dentro de una sola conversación. En su lugar, Claude Code genera un **harness** específico para la tarea: un script JavaScript que codifica la orquestación, lanza subagentes, guarda estado intermedio fuera del contexto principal y devuelve una síntesis final.

La idea no es solamente "más subagentes". Es mover la estrategia de ejecución a código inspeccionable para que el sistema pueda:

- paralelizar trabajo independiente;
- preservar resultados intermedios sin llenar el contexto principal;
- aplicar patrones de calidad repetibles;
- reanudar o gestionar runs desde una vista de workflows;
- verificar hallazgos antes de reportarlos.

## Qué es un Dynamic Workflow en Claude Code

Según la documentación oficial, un workflow dinámico es un script JavaScript que Claude escribe para la tarea descrita por el usuario y que un runtime ejecuta en background. El script actúa como coordinador: mantiene loops, branching, variables intermedias y reglas de reducción, mientras los subagentes hacen el trabajo concreto.

Diferencia principal frente a otras capacidades:

| Mecanismo | Quién sostiene el plan | Dónde quedan los resultados intermedios | Escala típica |
| --- | --- | --- | --- |
| Subagents | Claude, turno por turno | Contexto de Claude | Pocas delegaciones por turno |
| Skills | Instrucciones que Claude sigue | Contexto de Claude | Similar a subagents |
| Agent teams | Un agente líder supervisa peers | Task list compartida | Algunos peers persistentes |
| Workflows | Un script ejecutado por runtime | Variables/artifacts del script | Decenas a cientos de agentes |

Claude recomienda workflows cuando una tarea necesita más agentes de los que una conversación puede coordinar bien, o cuando conviene que la orquestación quede codificada y se pueda leer o reutilizar.

Ejemplos oficiales:

- barrido de bugs en todo un codebase;
- migración de cientos de archivos;
- investigación que requiere cruzar fuentes;
- un plan difícil que conviene evaluar desde varios ángulos antes de implementar.

## Entradas y UX en Claude Code

Claude Code ofrece tres entradas principales:

1. **Workflow bundled**: `/deep-research <question>`.
   - Hace fan-out de búsquedas web por ángulos.
   - Descarga y cruza fuentes.
   - Vota o filtra claims.
   - Devuelve un reporte citado.

2. **Pedido explícito**.
   - Incluir `ultracode` en el prompt.
   - O pedir en lenguaje natural: "use a workflow", "run a workflow".
   - Claude escribe un script para esa tarea y lo ejecuta.

3. **`/effort ultracode`**.
   - Combina `xhigh` reasoning effort con orquestación automática.
   - Claude decide cuándo una tarea sustantiva merece uno o más workflows.
   - Puede encadenar workflows: entender → modificar → verificar.
   - Es por sesión y se resetea al iniciar una nueva.

## Aprobación, permisos y seguridad

Antes de correr un workflow, Claude Code muestra una aprobación con fases planeadas. Opciones documentadas:

- correr una vez;
- correr y no volver a preguntar para ese workflow en ese proyecto;
- ver el script crudo;
- cancelar;
- abrir el script en editor con `Ctrl+G`.

La prompt depende del permission mode. En modos no interactivos (`claude -p`, SDK, bypass permissions) puede arrancar sin prompt.

**Punto importante:** los subagentes corren con `acceptEdits` e heredan el tool allowlist de la sesión. Las ediciones de archivos se autoaprueban, pero shell, web fetches y MCP tools fuera del allowlist todavía pueden pedir permiso durante el run.

## Guardado y reutilización

Si un run funciona, se puede guardar como comando desde `/workflows` con `s`.

Ubicaciones documentadas:

- `.claude/workflows/` en el proyecto, compartible con el repo;
- `~/.claude/workflows/` en home, personal/global.

Los workflows guardados se invocan como slash commands (`/<name>`). También pueden recibir input vía un global `args`, para pasar preguntas, paths, issue numbers o configuración estructurada sin editar el script.

Claude Code carga workflows de `.claude/workflows/` a lo largo del path del proyecto; si hay nombres duplicados, gana el más cercano al cwd. Los workflows de proyecto ganan sobre los personales.

## Runtime y límites oficiales

Restricciones documentadas del runtime:

| Restricción | Razón |
| --- | --- |
| No user input a mitad del run | Para sign-off entre etapas, correr workflows separados |
| El workflow no tiene acceso directo a filesystem/shell | Los agentes leen, escriben y ejecutan; el script coordina |
| Hasta 16 agentes concurrentes | Limitar recursos locales |
| Hasta 1,000 agentes por run | Evitar loops descontrolados |

Gestión de runs:

- `/workflows` lista runs activos y completados.
- La vista de progreso muestra fases, agentes, tokens y elapsed.
- Se puede pausar/reanudar (`p`), detener (`x`), reiniciar agentes (`r`) y guardar script (`s`).
- Si se pausa un run, al reanudar los agentes completados devuelven resultados cacheados y el resto corre live.
- La reanudación dentro de la misma sesión restaura estado. Si se cierra Claude Code durante un run, la siguiente sesión arranca de cero.

## Patrones nombrados por Anthropic

Los patrones destacados en la cobertura del blog y la documentación son:

- **Classify-and-act**: clasificar items y elegir acción por clase.
- **Fan-out-and-synthesize**: dividir trabajo independiente y sintetizar.
- **Adversarial verification**: agentes escépticos verifican claims o hallazgos.
- **Generate-and-filter**: producir muchas opciones y filtrar por criterios.
- **Tournaments**: comparar candidatos en rondas o jurados.
- **Loop-until-done**: iterar con una condición de salida observable.

## Costo y cuándo no usarlo

Anthropic advierte que un workflow puede gastar muchos más tokens que resolver la tarea conversacionalmente, porque dispara muchos subagentes. La recomendación oficial es probar primero con un slice pequeño, por ejemplo un directorio en vez de todo el repo, o una pregunta estrecha en vez de un tema amplio.

No conviene usar workflows para tareas normales de edición o preguntas simples. El criterio fuerte es si hay escala, independencia, verificación cruzada o necesidad de reutilizar la orquestación.

## Comparación con este repo, Pi Dynamic Workflows

Lo que ya está alineado:

- Scripts JavaScript específicos de la tarea.
- `dynamic_workflow` para listar, templar, escribir, correr, resumir y ver workflows.
- Background por defecto en TUI/RPC.
- Dashboard `/workflows`.
- `ctx.agent`, `ctx.agents`, `ctx.pipeline`, `ctx.parallel`, `ctx.workflow`.
- Límites similares: `concurrency` hard cap 16 y `maxAgents` hard cap 1000.
- Drafts y artifacts fuera del contexto conversacional.
- `ultracode`/router always-on y `/effort ultracode`.
- Templates equivalentes: scout-fanout, adversarial-verify, tournament, loop-until-dry, self-consistency, deep-research, repo-bug-hunt.
- Resume más fuerte que Claude en un punto: este repo persiste un journal content-addressed para reanudar runs stale/failed/cancelled in-place entre sesiones Pi, reutilizando llamadas completadas.

## Deltas o ideas para acercarse más a Claude

1. **Aprobación pre-run con fases y raw script**
   - Claude muestra fases planeadas y deja ver o editar el script antes de ejecutar.
   - En Pi: agregar modo de aprobación humano para workflows generados, especialmente con tools mutantes.

2. **Guardar run como slash command directo**
   - Claude permite `s` en `/workflows` e invocar `/<name>` después.
   - En Pi: ya existe `/workflow run <name>`, pero generar comandos dinámicos o una UX equivalente mejoraría el flujo.

3. **Input natural a workflows guardados**
   - Claude usa `args` estructurado inferido del prompt.
   - En Pi: aceptar `/workflow run name <texto>` y pedirle al modelo estructurar `input`, o crear aliases con schema.

4. **Métricas de tokens por fase/agente**
   - Claude muestra token totals en la vista de progreso.
   - En Pi: las métricas no persistidas (`tokens`/`cost`/`model`/`toolCalls`) no se muestran actualmente; documentar el estado o agregar soporte.

5. **Pause/restart granular desde dashboard**
   - Claude ofrece pause/resume de run, stop de agente/run y restart de agente.
   - En Pi: se tiene cancel/resume; agregar pausa y restart por agente daría más control.

6. **Modelo de permisos por agente**
   - Claude separa aprobación del run y permisos de subagente por allowlist.
   - En Pi: ya permite tools/keys/env por agente; documentar y reforzar presets read-only/mutating.

7. **Modo coordinador restringido (sin shell/filesystem directo)**
   - Claude restringe el script: solo coordina, los agentes actúan.
   - En Pi: se permite `ctx.bash`, `readFile`, `writeFile` y artifacts (más potente, pero menos aislado). Podría existir un modo restringido para workflows no confiables o compartibles.

## Recomendación para Pi

Mantener la ventaja actual de Pi: workflows como código confiable, composable y resumable.

Pero adoptar tres elementos de UX de Claude porque mejoran seguridad y reutilización:

1. **Pre-run approval para workflows generados**: mostrar nombre, fases, límites, tools mutantes y raw script.
2. **Save-as-command**: promover desde run/draft a comando invocable sin recordar `/workflow run`.
3. **Args ergonómicos**: permitir input estructurado o natural para workflows guardados.

El siguiente slice seguro sería documentar estos deltas como roadmap e implementar primero `save-as-command`, porque es de bajo riesgo: no cambia el runtime, solo la capa de descubrimiento e invocación.
