---
type: "Research Note"
title: "OpenProse (\"Prose\") — análisis y comparación con Dynamic Workflows"
description: "Análisis de OpenProse y comparación con Dynamic Workflows."
tags: [openprose, workflows, declarative, agents]
timestamp: 2026-07-04T00:00:00Z
---

# OpenProse ("Prose") — análisis y comparación con Dynamic Workflows

Fecha: 2026-07-04

## En 30 segundos

OpenProse propone tratar una sesión de IA como un programa declarativo escrito en Markdown. Sirve para convertir flujos exitosos en contratos versionables y reutilizables, con trazabilidad de ejecución.

Este informe resume cómo funciona su modelo y qué cambia frente a los dynamic workflows imperativos de este repo. La comparación ayuda a decidir qué ideas conviene adoptar y cuáles chocan con nuestro foco en control explícito y evidencia inspeccionable.

## Objetivo

Entender qué es OpenProse (el "programming language for AI sessions" detrás del skill local `open-prose`), cómo funciona su modelo de contratos declarativos y cómo se compara con los dynamic workflows imperativos de este repo — para poder tomar lo útil y dejar claras las compensaciones.

## Fuentes revisadas

- **prose.md / openprose.ai** (sitio oficial; openprose.ai redirige con 301 a
  prose.md) — modelo declarativo, primitivas, lista de harnesses "Prose Complete".
  <https://prose.md/>
- **Turing Post — "OpenProse: A Language for Reliable AI Agent Workflows"**
  (artículo invitado de Raymond Weitekamp, junio de 2026) — motivación, receipts,
  ProseScript, limitaciones honestas.
  <https://www.turingpost.com/p/openprose-a-language-for-reliable-agents>
- **DEV Community — "OpenProse: A Programming Language for AI Sessions"**
  (Steven Gonsalvez) — ejemplo de sintaxis, resolución de contratos en Forme,
  crítica de debugging.
  <https://dev.to/stevengonsalvez/openprose-a-programming-language-for-ai-sessions-d84>
- **Sean Weldon — "Recursive Coding Agents" (entrevista con Raymond
  Weitekamp, 2026-06-27)** — contexto sobre uso recursivo y self-hosted.
  <https://www.sean-weldon.com/blog/2026-06-27-recursive-coding-agents-raymond-weitekamp-openprose>
- **Skill local** `~/.agents/skills/open-prose/` (v0.15.0, también instalado en
  `~/.claude/skills/open-prose/`) — `SKILL.md`, cinco piezas centrales,
  contrato de activación.

## Qué es OpenProse

OpenProse (Raymond Weitekamp, open source) trata una sesión de IA como una
máquina virtual Turing-complete. Los programas son archivos Markdown
(`*.prose.md`) con YAML frontmatter; el propio agente de código actúa como
compiler y runtime — no hay servidor externo ni framework de orquestación.
Funciona sobre cualquier harness "Prose Complete": Claude Code, OpenCode, Amp,
Codex.

El problema que apunta no es la capacidad del modelo, sino la confianza y la
reutilización: las sesiones exitosas desaparecen en el historial del chat,
lo que obliga a babysittear agentes en vez de reproducir flujos probados.
OpenProse convierte esos flujos en contratos versionables, y cada ejecución deja
un audit trail ("receipts").

## Modelo de ejecución

- **Contratos declarativos.** Una unidad de trabajo (una *responsibility*)
  declara `### Requires` (precondiciones/inputs), `### Ensures`
  (poscondiciones/outputs) y estrategias preferidas. No hay secuenciación
  explícita: si el paso A *ensures* lo que el paso B *requires*, A corre antes;
  los pasos independientes se paralelizan automáticamente.
- **Forme** es el contenedor semántico de dependency injection que conecta
  responsibilities haciendo match entre sus contratos.
- **ProseScript** es la capa imperativa opcional para coreografía fijada — orden
  explícito, loops, conditionals, retries y bloques paralelos dentro de un
  bloque `### Execution`.
- **Ejecución en sesión.** A diferencia de LangChain/CrewAI/AutoGen
  (orquestación externa) o BAML/DSPy (harness externo), el agente lee el Markdown
  y se convierte en la VM, crea subagentes y persiste el estado de ejecución en
  un OpenProse root.
- También soporta persistent agents (estado entre invocaciones), pipelines y
  variables intermedias.

Ejemplo mínimo de paso (tomado del artículo de DEV):

```markdown
---
requires: [codebase_analysis]
ensures: [test_plan]
---

Review the codebase analysis and create a comprehensive test plan
covering all edge cases for the authentication module.
```

## Skill local (v0.15.0)

El skill `open-prose` instalado documenta cinco piezas centrales:

| Pieza | Archivo | Rol |
|-------|---------|-----|
| Contract Markdown | `contract-markdown.md` | Formato fuente legible de `*.prose.md` |
| Forme | `forme.md` | Contenedor semántico de DI que conecta contratos |
| Prose VM | `prose.md` | Motor de ejecución para responsibilities/functions |
| ProseScript | `prosescript.md` | Capa imperativa para bloques `### Execution` |
| Responsibility Runtime | `responsibility-runtime.md` | Standing goals, Reactor, doctrina compile/serve |

Activación: escribir `prose ...`, abrir un `.prose.md` con frontmatter `kind:`,
o pedir orquestación multi-agente reutilizable; `prose run` es una instrucción
en sesión (el agente encarna la VM — no existe un binario `prose`).

## Fortalezas y limitaciones

Fortalezas: portable entre harnesses, sin dependencias externas, los programas
mejoran gratis a medida que mejoran los modelos, Markdown+YAML es legible y
amigable con Git, paralelización automática a partir de contratos.

Limitaciones (el creador las plantea explícitamente): no convierte un LLM en
infraestructura determinista — las ejecuciones siguen siendo no deterministas,
los contratos tienen que estar bien diseñados y funciona mejor con frontier
models. El debugging es el trade-off más duro: cuando el runtime decide el orden
de ejecución, explicar *por qué* ejecutó en ese orden exige entender el
algoritmo de resolución de contratos.

## Comparación con los dynamic workflows de este repo

| Dimensión | OpenProse | pi-dynamic-workflows |
|-----------|-----------|----------------------|
| Paradigma | Contratos declarativos (Requires/Ensures) | JavaScript imperativo (`pipeline()`, `parallel()`) |
| Quién decide el orden | Forme (semantic contract matching) | El script, de forma explícita |
| Escape hatch | ProseScript para coreografía fijada | n/a (el orden siempre está fijado) |
| Determinismo del control flow | Resuelto por el modelo, no determinista | Script determinista |
| Observabilidad / debugging | Receipts; el orden exige entender la resolución | Runs, artifacts, journal; el orden se lee en el código |
| Portabilidad | Cualquier harness "Prose Complete" | Claude Code (Workflow) y pi (`dynamic_workflow`) |

Mismo objetivo (orquestación multi-agente reutilizable), apuesta inversa:
OpenProse optimiza expresividad y reutilización de intención; este repo optimiza
control flow determinista y evidencia inspeccionable — justo la propiedad que
las instrucciones del proyecto llaman "observable workflows, inspectable
artifacts over hidden magic".

## Próximos pasos posibles

- Leer los ejemplos locales (`~/.agents/skills/open-prose/examples/`, por
  ejemplo `session-to-prose`) para ver una responsibility completa en práctica.
- Evaluar si un encabezado de contrato estilo Requires/Ensures mejoraría la
autodocumentación de nuestros workflow drafts sin perder el orden scriptado.
- Comparar `workflow-factory` con el flujo session-to-prose de OpenProse (ambos
  convierten una sesión ad hoc exitosa en un artifact reutilizable).
