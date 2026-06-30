# Dashboard improvement backlog

Canonical list of pending/closed items for the `/workflow` TUI dashboard improvement
loop. Narrative of each pass lives in `dashboard-improvement-log.md`; this file is the
single source of truth for what's still open. Each item: stable id, title, why, real
paths (verified to exist), status (`open` / `done` / `human`).

## Done

- **DW-DASH-001 — Extract shared "Selected agent" detail helper** · `done`
  - Why: the detail block was duplicated near-identically in two render paths, so any
    field-format edit risked silent divergence between Monitor and Agents.
  - Paths: `extensions/pi-dynamic-workflows/workflow-dashboard.ts`
    (`renderSelectedAgentDetail`), `extensions/pi-dynamic-workflows/tests/integration/dashboard-selected-agent-detail.test.mjs`.
- **DW-DASH-002 — Pin switch-session arg quoting/parsing round-trip** · `done`
  - Why: `parseWorkflowCommandArgument` (the `switch-session` arg path) had zero
    coverage; a naive quote-strip would break session paths containing spaces/unicode.
  - Paths: `extensions/pi-dynamic-workflows/tests/integration/switch-session-arg-roundtrip.test.mjs`,
    `extensions/pi-dynamic-workflows/dashboard-orchestration.ts` (exports the helper).

## Open (in allow-set; safe to pick up next)

- **DW-DASH-003 — Collapse the duplicated per-row agent line formatting** · `open`
  - Why: `renderMonitorAgents` and `renderAgents` still build the per-row
    `tools/skills/extensions/keys` (and the `schema` chip) with near-identical
    `muted(...)` expressions; only the prefix label/elapsed-vs-workflow segment differs.
    A behavior-preserving extraction (e.g. `renderAgentRowMeta(...)`) would remove the
    second-largest duplication left after DW-DASH-001.
  - Paths: `extensions/pi-dynamic-workflows/workflow-dashboard.ts`
    (`renderMonitorAgents` ~L805, `renderAgents` ~L884); new contract test under
    `extensions/pi-dynamic-workflows/tests/integration/`.

## Human (needs a decision; not auto-fixable in allow-set)

- **DW-DASH-H1 — Confirm the new gate baseline (HEAD moved)** · `human`
  - Why: the driving prompt pins the hard gate at `HEAD == fad9875`, but the human
    committed the previously-dirty foreign files, advancing HEAD to `9010157`
    (`1c356e8`, `251c2c2`, `9010157`). The hard safeguard treats any HEAD change as
    BLOCKED, so autopilot must not re-baseline silently. Human should confirm `9010157`
    (or later) as the baseline for the next pass.
  - Paths: `.git/refs/heads/main` (current `9010157`).
- **DW-DASH-H2 — Own/format/keep the untracked collectors contract test** · `human`
  - Why: `dashboard-collectors-contract.test.mjs` is an untracked test of uncertain
    provenance sitting in the auto-discovered verify path. Per the safeguard against
    editing foreign uncommitted files it was NOT touched this pass, but it runs in the
    orchestrator's `for f in tests/integration/*.test.mjs` loop and under
    `biome check`. Human should confirm ownership and either keep/format or remove it so
    the verify loop is trustworthy.
  - Paths: `extensions/pi-dynamic-workflows/tests/integration/dashboard-collectors-contract.test.mjs`.

## Ideas requiring hot files (propose only — do NOT implement in autopilot)

- **DW-DASH-H3 — Jump-to-next-active-run shortcut in Runs/Activity** · `human`
  - Why: a keybinding to jump to the next active run would speed monitoring, but wiring
    a new key/command likely touches the hot `index.ts` (command/keymap registration),
    which is outside the allow-set. Propose here; implement only with explicit human
    approval to edit `index.ts`.
  - Paths: `extensions/pi-dynamic-workflows/index.ts` (hot — do not edit),
    `extensions/pi-dynamic-workflows/workflow-dashboard.ts` (input handling).
