# Dashboard improvement log

Chronological, append-only narrative of `/workflow` TUI dashboard improvement passes.
Pending work lives in `dashboard-improvement-backlog.md`, not here.

## 2026-06-30 — Collapse duplicated "Selected agent" detail block (finalize: gate tripped)

- **Mejora (pass):** El bloque de detalle "Selected agent" estaba duplicado casi
  idéntico en `renderMonitorAgents` y `renderAgents`. Se extrajo a un helper privado
  compartido `renderSelectedAgentDetail(...)`, parametrizado SOLO por las tres
  diferencias reales: `headerLines` (workflow/run/parallel, solo Agents),
  `includeSchemaInState` (sufijo `• schema …` solo Agents) y `compactWidth`
  (220 Monitor vs 260 Agents). La línea de acciones de Agents queda fuera del helper.
  Behavior-preserving: ambos tabs renderizan las mismas líneas de detalle para una
  entrada equivalente.
- **Archivos REALES tocados (pass):**
  - `extensions/pi-dynamic-workflows/workflow-dashboard.ts` — helper
    `renderSelectedAgentDetail` (def. ~L737; usado en Monitor ~L853 y Agents ~L927).
  - `extensions/pi-dynamic-workflows/tests/integration/dashboard-selected-agent-detail.test.mjs`
    — ancla el contrato: líneas compartidas byte-idénticas entre ambos tabs + las tres
    diferencias intencionales (header / schema suffix / ancho 220 vs 260).
  - `extensions/pi-dynamic-workflows/tests/integration/switch-session-arg-roundtrip.test.mjs`
    — fija el round-trip de quoting↔parsing de `parseWorkflowCommandArgument` para el
    comando `switch-session` (ruta antes sin cobertura).
- **Finalize (esta corrida):** solo se agregaron los docs de `docs/research/`
  (este log + backlog). No se editó código ni se corrió verificación (lo hace el
  orquestador). No se tocaron archivos calientes ni el test ajeno
  `dashboard-collectors-contract.test.mjs`.
- **Verificación:** DIFERIDA al orquestador (el gate prohíbe ejecutarla aquí). Plan
  esperado en verde: `tsc --noEmit` · `biome check extensions/pi-dynamic-workflows` ·
  bucle `for f in tests/integration/*.test.mjs` · esbuild de la ext · `node --check`.
- **Evidencia / estado:** GATE DURO DISPARADO. HEAD esperado por el driving prompt =
  `fad9875`; HEAD real = `9010157` (commits humanos `1c356e8`, `251c2c2`, `9010157`
  absorbieron los archivos sucios ajenos del inicio). Por la salvaguarda dura
  ("si cambia HEAD → BLOCKED") no se re-baseliza en autopiloto: requiere confirmación
  humana del nuevo baseline antes de seguir. El trabajo del pass queda intacto en el
  working tree (allow-set) y documentado; pendientes → backlog.
