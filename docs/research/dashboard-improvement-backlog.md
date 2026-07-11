---
type: "Research Backlog"
title: "Backlog de mejoras del dashboard"
description: "Backlog canónico de mejoras pendientes y cerradas del dashboard TUI de workflows."
tags: [dashboard, backlog, dynamic-workflows, tui]
---

# Backlog de mejoras del dashboard

Esta es la lista canónica de ítems pendientes y cerrados del ciclo de mejora del TUI `/workflow` del dashboard. El
relato de cada pasada vive en `dashboard-improvement-log.md`; este archivo deja el estado actual, con una sola fuente de
verdad para lo que sigue abierto. Cada ítem incluye id estable, título, motivo, rutas reales (verificadas) y estado
(`open` / `done` / `human`).

## En 30 segundos

Usá esta página para ver qué ya quedó cerrado, qué sigue abierto y qué requiere una decisión humana. Si vas a retomar el
loop de mejoras, empezá por **Abiertos** y seguí cada ítem por su id estable.

## Cerrados

- **DW-DASH-001 — Extraer helper compartido del detalle de "Selected agent"** · `done`
  - Por qué: el bloque de detalle estaba duplicado casi idénticamente en dos rutas de render, así que cualquier cambio
    en el formato de campos podía divergir en silencio entre Monitor y Agents.
  - Rutas: `extensions/pandi-dynamic-workflows/workflow-dashboard.ts` (`renderSelectedAgentDetail`),
    `extensions/pandi-dynamic-workflows/tests/integration/dashboard-selected-agent-detail.test.mjs`.
- **DW-DASH-002 — Fijar el round-trip de quoting/parsing de `switch-session`** · `done`
  - Por qué: `parseWorkflowCommandArgument` (la rama de argumentos de `switch-session`) no tenía cobertura; un recorte
    ingenuo de comillas rompería rutas de sesión con espacios o Unicode.
  - Rutas: `extensions/pandi-dynamic-workflows/tests/integration/switch-session-arg-roundtrip.test.mjs`,
    `extensions/pandi-dynamic-workflows/dashboard-orchestration.ts` (exporta el helper).
- **DW-DASH-003 — Colapsar el formato duplicado de la línea por fila de agentes** · `done`
  - Por qué: `renderMonitorAgents` y `renderAgents` construían el sufijo de chips por fila
    `prompt schema tools skills extensions keys` byte a byte igual, con expresiones
    `muted(...)`/`success(...)`/`warning(...)`/`error(...)` duplicadas; solo diferían el prefijo, el segmento
    elapsed-vs-workflow y el chip `code:` de Monitor. Se extrajo un helper privado `renderAgentRowMeta(...)`,
    preservando el comportamiento, para construir la cadena común en un solo lugar.
  - Rutas: `extensions/pandi-dynamic-workflows/workflow-dashboard.ts` (`renderAgentRowMeta`, usado en
    `renderMonitorAgents` y `renderAgents`),
    `extensions/pandi-dynamic-workflows/tests/integration/dashboard-agent-row-meta.test.mjs`.
- **DW-TOOL-001 — Hacer compatible el visor HTML de workflows con ambos harnesses** · `done`
  - Por qué: `build-workflow-artifact.mjs` (idéntico en `.pi/scripts/` y `.claude/scripts/`) solo manejaba scripts
    top-level estilo Claude; los workflows estilo ctx / export-default / CommonJS fallaban ("Unexpected token 'export'"
    / "module is not defined") y capturaban 0 nodos, así que el preview HTML quedaba vacío para `.pi/workflows/*.js`.
  - Resolución: el builder ahora reescribe `export default …` → `globalThis.__default`, provee un stub CommonJS `module`
    y, después de ejecutar el body, llama a la entrada capturada con un `ctx` de registro cuyos métodos apuntan a los
    mismos stubs (los helpers quedan dentro del objeto `ctx` para no chocar con `const compact` propio de los
    scaffolds). Verificado: `continuous-improvement` pasó de 0 a 5 nodos, `loop-engineering-*` ya corre y los scaffolds
    Claude quedaron sin cambios. Las dos copias divergieron a propósito: `.claude/scripts/build-workflow-artifact.mjs`
    ahora es un wrapper CLI fino sobre `.claude/scripts/lib/artifact.mjs` con
    `--run`/`--watch`/`--match`/`--open`/`--interval` para monitoreo en vivo, mientras
    `.pi/scripts/build-workflow-artifact.mjs` sigue siendo el builder monolítico pre-lanzamiento (por la
    self-contained-extension rule, no se comparte código runtime entre ambos); la separación es intencional y no se
    resincronizan. Se eliminó el adaptador descartable `.pi/tmp/build-ctx-workflow-html.mjs`.
  - Rutas: `.pi/scripts/build-workflow-artifact.mjs`, `.claude/scripts/build-workflow-artifact.mjs`,
    `.claude/scripts/lib/artifact.mjs`.
- **DW-DASH-H1 — Confirmar la nueva baseline del gate (HEAD movido)** · `done` (resolved)
  - Resolución: la baseline del gate quedó fijada en `HEAD == da0a449`, con el working tree limpio y sin archivos sucios
    ajenos. La preocupación anterior sobre `fad9875`/`9010157` ya no aplica; este ítem es obsoleto en la baseline
    actual.
  - Rutas: `.git/refs/heads/main` (actual `da0a449`).
- **DW-DASH-H2 — Propiar/formatear/mantener el contract test de collectors** · `done` (resolved)
  - Resolución: `dashboard-collectors-contract.test.mjs` ya está trackeado y commiteado (no untracked), así que
    desapareció la preocupación de procedencia. Corre en verde en el loop de verificación autodetectado y pasa
    `biome check`; no hace falta otra decisión humana.
  - Rutas: `extensions/pandi-dynamic-workflows/tests/integration/dashboard-collectors-contract.test.mjs`.
- **DW-DASH-H3 — Atajo para saltar al próximo run activo en Runs/Activity** · `done`
  - Por qué: un keybinding para saltar al próximo run activo acelera el monitoreo de listas largas.
  - Resolución: se implementó SIN tocar el archivo caliente `index.ts`. El dashboard concentra toda la navegación
    intra-componente en `workflow-dashboard.ts handleInput` (`index.ts` solo registra `Ctrl+Alt+W` para abrirlo), así
    que la hipótesis original de que tocaría `index.ts` era incorrecta. `]` / `[` ahora mueven la selección al
    próximo/anterior run **running** en la pestaña Runs y a la próxima/anterior entrada running en Activity (con wrap;
    no-op si no hay nada en ejecución), en espejo con el ciclo `[` / `]` de Monitor y con `f` en Agents. Quedó cubierto
    por `dashboard-jump-active-run.test.mjs` (9 checks); también se actualizó el overlay de ayuda y la barra de ayuda
    por pestaña.
  - Rutas: `extensions/pandi-dynamic-workflows/workflow-dashboard.ts`,
    `extensions/pandi-dynamic-workflows/tests/integration/dashboard-jump-active-run.test.mjs`.

## Abiertos (en allow-set; seguros para tomar ahora)

_No hay elementos por ahora._

## Humanos (requieren decisión; no auto-fixable en allow-set)

_No hay decisiones humanas pendientes por ahora._

## Ideas que requieren archivos hot (solo proponer — no implementar en autopilot)

_No hay ideas pendientes que requieran archivos hot por ahora._
