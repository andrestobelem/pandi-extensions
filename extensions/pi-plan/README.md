# pi-dynamic-workflows-plan

Individual Pi package for the `/plan` extension.

## Install

From this repository:

```bash
pi install ./extensions/pi-plan
pi install -l ./extensions/pi-plan
pi --no-extensions -e ./extensions/pi-plan
```

## Provides

- `/plan [--ultracode] [--ultracode-steps] <task>` — enter read-only plan mode for a task.
- `/plan status` — inspect the active plan (status, posture flags, counts).
- `/plan dashboard` — open the plan-mode tracking dashboard (scrollable in a TUI; printed
  Markdown otherwise). Shows session totals, the active plan's posture/counts/last plan, and a
  history table of every plan in the session.
- `/plan exit|cancel` — leave plan mode without implementing.
- `enter_plan_mode` model tool: lets Pi enter plan mode **on its own** before a non-trivial,
  multi-step, or risky change (not only when a human types `/plan`). It arms the same read-only
  gate and hands the planning instruction back as its result; the human still approves. Accepts
  `nonInteractive`, `ultracode`, and `ultracodeSteps` booleans (see below).
- `submit_plan` model tool for submitting a plan artifact for explicit approval. In an
  interactive TUI the plan is presented in a scrollable, Markdown-rendered approval overlay
  (mdview-style: `↑/↓ j/k` scroll, `PgUp/PgDn` page; `y`/`Enter` approve, `n`/`Esc`/`q` reject) —
  a dismiss is a *reject*, never an implicit approval. When a custom component can't be shown it
  degrades to a plain `confirm` dialog.

While plan mode is active, mutating tools are blocked until the user approves the submitted plan.
The model can *enter* plan mode (`enter_plan_mode`) but can never *approve* a plan: in an
interactive session approval is always an explicit human confirmation.

## Posture flags (pass with parameters or set with env)

Three orthogonal, composable knobs tune plan mode. Each resolves with precedence
**explicit param → environment setting → default (off)**:

| Flag | `enter_plan_mode` param | `/plan` flag | Env setting | Effect |
| --- | --- | --- | --- | --- |
| Non-interactive | `nonInteractive` | (tool/env only) | `PI_PLAN_NONINTERACTIVE` | Plan-only: enter even in `print`/`json` (e.g. a workflow subagent) |
| Ultracode | `ultracode` | `--ultracode` | `PI_PLAN_ULTRACODE` | Tell the planner to research/design the plan **with dynamic workflows** |
| Ultracode steps | `ultracodeSteps` | `--ultracode-steps` | `PI_PLAN_ULTRACODE_STEPS` | Tell the planner/implementer to execute the plan's **steps via dynamic workflows** |

The `/plan` command is interactive-only and so does not take `--non-interactive`; non-interactive
entry is the `enter_plan_mode` tool's job (it returns the planning instruction as its own result,
so a one-shot/`--no-session` subagent keeps planning in the same turn).

**Session toggles.** `/plan ultracode on|off|status` and `/plan steps-ultracode on|off|status` set
an in-memory default for the rest of the session, so a flagless `/plan <task>` inherits it. They
sit between an explicit param and the env var (param → session toggle → env → off) and reset at
every session boundary.

### Non-interactive (plan-only) mode

In `print`/`json` sessions there is no human to approve, so plan mode runs **plan-only**: it arms
the read-only gate, you research and call `submit_plan`, and the plan is **returned as the
deliverable** — there is **no approval and no implementation**, and the gate **never lifts**
(mutation stays impossible for the whole session). Without the flag, `print`/`json` still refuses
to enter (unchanged back-compat). This is what lets a **dynamic-workflow subagent** produce a plan:

```js
// inside a workflow: get a plan back from a sandboxed, read-only subagent
const { output } = await ctx.agent("Plan the migration, then output the full plan.", {
  includeExtensions: true, // load pi-plan in the subagent
  env: { PI_PLAN_NONINTERACTIVE: "1", PI_PLAN_ULTRACODE_STEPS: "1" },
  // NOTE: do NOT give the planner `dynamic_workflow` run/start power. The plan should NAME the
  // workflows; the ORCHESTRATOR runs them. This keeps the composition non-recursive.
  tools: ["read", "grep", "find", "ls", "enter_plan_mode", "submit_plan"],
});
```

**Avoiding recursion.** Plan-only keeps the read-only gate armed for the whole session, so even
if a subagent had `dynamic_workflow` it could not `run`/`start` workflows while planning (only the
read-only catalog actions). The safe pattern is one-directional: a workflow spawns a plan-only
subagent that *produces* a plan naming the workflows to run, and the **orchestrator** (not the
subagent) executes them — never a subagent that spawns subagents that spawn workflows.

## Read-only gate

While planning, the gate (see `gate.ts`) hard-blocks mutation and allows only research:

- **Allowed:** `read`, `grep`, `find`, `ls`, and read-only shell (`git ls-files`, `git status`,
  `cat`, `head`, `sed -n` …).
- **Blocked:** `write`, `edit`, and mutating shell (`rm`, `mv`, `git commit/add/push/reset`,
  redirections `>`/`>>`, package installs …). The bash allowlist is best-effort and errs toward
  blocking.

### Dynamic workflows in a plan

`dynamic_workflow` is gated by **action**:

- **Allowed while planning (read-only):** `list`, `scaffold`, `read`, `graph`, `runs`, `view` —
  use them to inspect the catalog and design the right workflow.
- **Blocked while planning:** `run`, `start`, `resume`, `write`, `cancel`, `delete` (they can
  write files or spawn mutating subagents whose tool calls bypass this gate). A missing/unknown
  action is blocked too.

So a plan **may propose running dynamic workflows** (e.g. `action=run`/`start`) as
implementation steps for broad, parallel, or high-confidence work (large audits, migrations,
exhaustive sweeps, independent verification, deep research). Those execute only **after** the
user approves the plan and the gate lifts. The planning prompt tells the model this, so it knows
the option exists when designing the implementation.

For the full bundle of extensions and skills, install the repository root instead.
