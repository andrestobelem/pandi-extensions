# Loop engineering with our extensions

Date: 2026-06-28

A practical how-to that turns the
[loop-engineering investigation](./research/2026-06-28-loop-engineering.md)
into concrete usage of the extensions in this repo. The research explains *what*
loop engineering is and *why* the repo's mechanisms work; this guide explains
*which extension to reach for* and *how to drive it* in a loop-engineered way.

> **Definition (from the research).** *Loop engineering* is the discipline of
> **designing, bounding, and verifying** iterative/feedback loops so a loop makes
> measurable progress toward a goal and **stops on evidence** (`done` / `quiet` /
> `blocked`) rather than on a timer, a self-declaration, or never.

## The principle in one line

> Bound the loop **and** keep the critique signal independent and unbiased.

That is the decisive lesson behind every mechanism here: a model judging its own
work is unreliable (Huang et al., arXiv:2310.01798), so a trustworthy loop needs
both an explicit brake and an external check. `/goal` is the surface that enforces
both at once.

## TL;DR — pick the right loop surface

| Surface | Question it answers | Reach for it when | Principle it embodies |
| --- | --- | --- | --- |
| `/goal` | *What state am I in?* | The work has a verifiable `done` | Independent verification (strongest) |
| `/loop` | *When do I wake up?* | Recurring watch with no "finish" | Bounded cadence, never trust the model |
| `loop-until-done` workflow | *Has it converged yet?* | Parallel sweep until no new findings | Convergence by quiet rounds |
| `/effort ultracode` + Contract Gate | *What does "done" even mean?* | Before orchestrating broad work | Bound and verify the scope first |

## The four loop surfaces

### `/goal` — closed-loop with independent verification

Use `/goal` whenever there is a concrete, checkable definition of done. It runs
`pursuing → verifying → verifying-independent → done | blocked`: a self
completeness check, then a **separate read-only adversarial subagent** that emits
`VERDICT: PASS | FAIL`. Only an independent `PASS` closes the goal
(`extensions/pi-goal/index.ts:362-386`). This is the repo's direct architectural
answer to the self-correction-is-unreliable result.

```bash
# Objective -- success criteria after the `--`
/goal migrate tests to vitest -- all tests pass; no jest imports remain
/goal status
/goal stop
```

Guardrails you inherit for free:

- Never an infinite loop; bounded rounds and caps (`pi-goal/index.ts:51`).
- A claim without verifiable evidence is a `FAIL` (`pi-goal/index.ts:319`).
- Oscillation guard: `maxIndependentVerifications` (default 2) flips a thrashing
  goal to `blocked` instead of looping forever (`pi-goal/index.ts:116`).

### `/loop` — bounded cadence, never trust the model

Use `/loop` for recurring work that has no binary "done": monitoring, polling,
autopilot. The model proposes a wake delay; the extension **saturates it** to a
safe band of `[60, 3600]s` so a bad value can never destabilize the loop
(`extensions/pi-loop/index.ts:103`, `:1186-1188`).

```bash
# Fixed cadence (last token is the interval)
/loop check whether CI went green 10m

# Dynamic cadence (the model picks the delay; it is clamped)
/loop watch the deploy and report when it stabilizes

# Trusted autonomous loop (requires /trust first)
/loop auto keep the docs index in sync with docs/ 1h

/loop status   /loop pause   /loop resume   /loop stop
```

Choose the cadence regime deliberately:

- Short poll (`< 300s`, never exactly 300) for fast external state (CI, deploy)
  while keeping a warm cache.
- Long fallback (`1200–1800s`) when idle with no concrete signal.
- Do not poll work the harness already tracks (subagents, workflows) — use a long
  fallback and let it report back.

Defense in depth: wall-clock + iteration + best-effort context-budget caps
(`extensions/pi-loop/caps.ts:28-37`), plus a watchdog backstop above the deadline.
Note the context-budget cap is a **soft sensor** — it silently no-ops when usage is
unknown, so do not rely on it alone.

### `loop-until-done` — convergence by quiet rounds

When the goal is exhaustiveness rather than a single `done` (audits, repo-wide
searches), use the `loop-until-done` workflow template. It runs parallel finders
each round and stops when **no new findings appear for K consecutive rounds** — a
settle-to-tolerance detector, not a single transient-quiet flip.

```text
dynamic_workflow action=run name=loop-until-done \
  input={"finders":4,"quietRounds":2,"maxRounds":8}
```

- `quietRounds` (default 2) is a debounce/deadband, not a proven fixed point.
- `maxRounds` (default 8) is the hard brake; when it stops there, it says so
  out loud (`extensions/pi-dynamic-workflows/templates.ts:392-394`) — no silent
  caps.

### Ultracode + Contract Gate — bound the scope first

Before orchestrating broad or repo-wide work, let the Contract Gate pin down what
"done" means. It runs a small read-only task-contract review and emits
`improvedTask`, `successCriteria`, `assumptions`, `nonGoals`, `routingHints`,
`verificationPlan`, and `blockers` — so the loop optimizes against an agreed
target instead of a vague prompt.

```bash
/effort ultracode          # request xhigh + enable always-on routing
/ultracode-contract off    # disable the Contract Gate for this session
/ultracode-mode off        # turn the router off (lowering effort does not)
```

## The eight principles → knobs you control

| Principle | What it means in practice | Where to set it |
| --- | --- | --- |
| Bounded termination | Never loop forever on a task with a goal | Use `/goal` instead of `/loop` |
| Layered caps | Wall-clock + iterations + budget | `/loop` defaults; `maxRounds` in workflows |
| Cadence clamp | The model's delay is saturated, not trusted | `/loop` clamps to `[60, 3600]s` |
| Convergence | Stop when findings stay at ~0 | `quietRounds` in `loop-until-done` |
| Resumability | Rehydrate without a burst of catch-up | `dynamic_workflow action=resume` |
| Destructive gating | Gate risky actions on autopilot only | `/loop auto` after `/trust` |
| Independent verification | Close on an external signal, not self-claim | `/goal` independent verifier |
| No silent caps | Stopping at a budget must be reported | Keep the "stopped at maxRounds" log |

## Recipes

Run different work in parallel (they do not compose — see below):

```bash
/goal implement feature X -- criteria ...   # iterates until verified
/loop watch the X deploy 5m                 # repeats on a cadence
```

Manage each independently — they keep separate state and IDs:

```bash
/goal status     /goal stop [id]
/loop status     /loop pause [id]   /loop resume [id]   /loop stop [id]
```

## Anti-patterns

- **Do not** use `/loop` on a task that has a verifiable `done`; that is what
  `/goal` is for. `/loop` has no notion of "finished".
- **Do not** drive the *same* task with both `/goal` and `/loop` expecting the
  goal to set the loop's cadence. They are independent extensions with separate
  state and do **not** compose; only `ctx.isIdle()` keeps them from injecting into
  an in-flight turn. Pick one surface per task.
- **Do not** trust the context-budget cap as a hard guarantee — it is best-effort
  and can silently no-op.
- **Do not** report `done` when a loop merely hit its cap. Surface the cap.

## Provenance and sources

This guide operationalizes the source-backed investigation in
[`docs/research/2026-06-28-loop-engineering.md`](./research/2026-06-28-loop-engineering.md),
which carries the external citations (ReAct, Reflexion, Self-Refine, Huang et al.,
control/feedback theory) and the verified `file:line` grounding for every
mechanism referenced above. See also the broader
[agentic patterns map](./research/2026-06-25-agentic-patterns-papers-workflows.md)
and the side-by-side `/loop` vs `/goal` note in `.pi/notes/loop-y-goal.md`.
