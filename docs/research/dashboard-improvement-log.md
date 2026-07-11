---
type: "Research Log"
title: "Registro de mejoras del dashboard"
description: "Registro cronológico de mejoras del dashboard TUI de workflows."
tags: [dashboard, log, dynamic-workflows, tui]
timestamp: 2026-06-30T00:00:00Z
---

# Registro de mejoras del dashboard

Crónica cronológica y de agregado único de los pasajes de mejora del dashboard TUI de `/workflow`. Si estás buscando
trabajo pendiente, mirá `dashboard-improvement-backlog.md`; este archivo solo registra lo que ya se hizo.

## En 30 segundos

Este registro documenta cada pass de mejora del dashboard, en orden temporal. Sirve para reconstruir qué cambió, qué
archivos tocó cada paso y cómo se verificó. El trabajo pendiente vive en `dashboard-improvement-backlog.md`, no acá.

## 2026-06-30 — DW-DASH-003: collapse the duplicated per-row agent meta suffix

- **Mejora (pass):**
  - El sufijo de chips por-fila de agente (`prompt schema tools skills extensions keys`) se construía byte-idéntico en
    `renderMonitorAgents` y `renderAgents`, con expresiones `muted(...)`/`success(...)`/`warning(...)`/`error(...)`
    duplicadas.
  - Se extrajo un helper privado behavior-preserving `renderAgentRowMeta(agent, muted, success, error, warning)` que
    devuelve esa cadena común, invocado desde ambos render paths.
  - Quedan FUERA del helper, en cada caller, las dos diferencias intencionales:
    - El chip `code:` de Monitor (entre `elapsed:` y el meta)
    - El segmento `— <workflow> <runId>` de Agents (antes de `elapsed:`)
  - Sin renombres ni reordenamientos; salida renderizada idéntica byte-a-byte a la anterior en ambos tabs.

- **Archivos REALES tocados (pass):**
  - `extensions/pandi-dynamic-workflows/workflow-dashboard.ts` — nuevo helper privado `renderAgentRowMeta` (def. antes
    de `renderMonitorAgents`); ambos callers reemplazan los ~6 `const` de chips por
    `const meta = this.renderAgentRowMeta(...)`.
  - `extensions/pandi-dynamic-workflows/tests/integration/dashboard-agent-row-meta.test.mjs` — test behavioral nuevo
    (patrón `buildExtension` + `loadModule` + `WorkflowDashboard.render(WIDTH)`): para un mismo agente verifica que el
    meta suffix (`prompt…keys`) es byte-idéntico entre la fila de Monitor y la de Agents, y que persisten las dos
    divergencias (`code:` solo en Monitor; `— <workflow> <runId>` solo en Agents). Autodescubierto por
    `scripts/test/run-all.mjs` (convención `tests/integration/*.test.mjs`) — manifest sin tocar.
  - `docs/research/dashboard-improvement-backlog.md` — DW-DASH-003 → Done; H1/H2 marcados resueltos al baseline
    `da0a449`.

- **Verificación (verde):**
  - `tsc -p tsconfig.json --noEmit`
  - `biome check extensions/pandi-dynamic-workflows` (98 files, sin errores)
  - Loop `for f in tests/integration/*.test.mjs` (todas las suites PASS, incl. la nueva con 9 checks)
  - esbuild de `workflow-dashboard.ts` a `.pi/tmp/wfdash.check.mjs` OK (artifact borrado)
  - `node --check` de la `.mjs` nueva OK

- **Verificación adversarial:** mutando SOLO el caller de Agents (append `stray:1` tras `${meta}`) el test FALLA
  (`per-row meta suffix … byte-identical` → exit 1), probando que ancla la divergencia por-caller; revertido y
  re-verificado verde.

- **Gate:** baseline `da0a449`, working tree limpio al iniciar; cambios solo dentro del allow-set
  (`workflow-dashboard.ts`, `tests/integration/**`, `docs/research/**`). Sin tocar `index.ts` ni otros archivos
  calientes. Sin commit (lo hace el humano).

## 2026-06-30 — Collapse duplicated "Selected agent" detail block (finalize: gate tripped)

- **Mejora (pass):**
  - El bloque de detalle "Selected agent" estaba duplicado casi idéntico en `renderMonitorAgents` y `renderAgents`.
  - Se extrajo a un helper privado compartido `renderSelectedAgentDetail(...)`, parametrizado SOLO por las tres
    diferencias reales:
    - `headerLines` (workflow/run/parallel, solo Agents)
    - `includeSchemaInState` (sufijo `• schema …` solo Agents)
    - `compactWidth` (220 Monitor vs 260 Agents)
  - La línea de acciones de Agents queda fuera del helper.
  - Behavior-preserving: ambos tabs renderizan las mismas líneas de detalle para una entrada equivalente.

- **Archivos REALES tocados (pass):**
  - `extensions/pandi-dynamic-workflows/workflow-dashboard.ts` — helper `renderSelectedAgentDetail` (def. ~L737; usado
    en Monitor ~L853 y Agents ~L927).
  - `extensions/pandi-dynamic-workflows/tests/integration/dashboard-selected-agent-detail.test.mjs` — ancla el contrato:
    líneas compartidas byte-idénticas entre ambos tabs + las tres diferencias intencionales (header / schema suffix /
    ancho 220 vs 260).
  - `extensions/pandi-dynamic-workflows/tests/integration/switch-session-arg-roundtrip.test.mjs` — fija el round-trip de
    quoting↔parsing de `parseWorkflowCommandArgument` para el comando `switch-session` (ruta antes sin cobertura).

- **Finalize (esta corrida):**
  - Solo se agregaron los docs de `docs/research/` (este log + backlog).
  - No se editó código ni se corrió verificación (lo hace el orquestador).
  - No se tocaron archivos calientes ni el test ajeno `dashboard-collectors-contract.test.mjs`.

- **Verificación:** DIFERIDA al orquestador (el gate prohíbe ejecutarla aquí). Plan esperado en verde:
  - `tsc --noEmit`
  - `biome check extensions/pandi-dynamic-workflows`
  - Loop `for f in tests/integration/*.test.mjs`
  - esbuild de la ext
  - `node --check`

- **Evidencia / estado:**
  - GATE DURO DISPARADO.
  - HEAD esperado por el driving prompt = `fad9875`; HEAD real = `9010157` (commits humanos `1c356e8`, `251c2c2`,
    `9010157` absorbieron los archivos sucios ajenos del inicio).
  - Por la salvaguarda dura ("si cambia HEAD → BLOCKED") no se re-baseliza en autopiloto: requiere confirmación humana
    del nuevo baseline antes de seguir.
  - El trabajo del pass queda intacto en el working tree (allow-set) y documentado; pendientes → backlog.
