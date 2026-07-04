# @pandi-coding-agent/plan

`/plan` is Claude-style read-only plan mode for Pi: it researches and drafts a plan while every mutating tool is hard-blocked, then implements only after you give explicit approval. Reach for it before a risky, multi-step, or ambiguous change, so you can review the approach before any file gets touched.

```text
/plan Add OAuth login to the API -- inspect the existing auth flow, then propose the changes
```

Pi researches read-only, calls `submit_plan` with the full plan, and shows it in a scrollable Markdown overlay. Press `y`/`Enter` to approve and implement, or `n`/`Esc`/`q` to reject and have it revise.

## What you get

- A `/plan` command that arms a read-only gate for a task until you approve the submitted plan.
- An `enter_plan_mode` model tool, so Pi can enter plan mode on its own before a non-trivial or risky change — approval still stays with you.
- A `submit_plan` model tool with a scrollable, Markdown-rendered approval overlay; a dismiss is a reject, never an implicit approval.
- A per-session tracking dashboard and status line.
- Composable "ultracode" posture flags that tell the planner or implementer to use dynamic workflows.

## Install

From npm:

```bash
pi install npm:@pandi-coding-agent/plan
```

From this repository:

```bash
pi install ./extensions/pi-plan          # global (your user)
pi install -l ./extensions/pi-plan       # project-local
pi --no-extensions -e ./extensions/pi-plan   # one-off trial, nothing else loaded
```

## Commands

| Command | What it does |
| --- | --- |
| `/plan [--ultracode\|--uc] [--ultracode-steps\|--uc-steps] <task>` | Enter read-only plan mode for a task. |
| `/plan status` | Inspect the active plan: status, posture flags, counts. |
| `/plan dashboard` | Open the tracking dashboard: session totals, the active plan, and a history table of every plan in the session (scrollable in a TUI; printed Markdown otherwise). |
| `/plan ultracode on\|off\|status` | Session default for the ultracode posture; a flagless `/plan <task>` inherits it. |
| `/plan steps-ultracode on\|off\|status` | Session default for the ultracode-steps posture. |
| `/plan exit\|cancel` | Leave plan mode without implementing. |
| `enter_plan_mode` | Model tool: Pi enters plan mode itself before a multi-step or risky change. Accepts `nonInteractive`, `ultracode`, and `ultracodeSteps` booleans. |
| `submit_plan` | Model tool: submit the plan artifact for explicit human approval. |

## `/plan` vs `enter_plan_mode`

Both arm the same read-only gate and end at `submit_plan`; they differ in who
starts planning and where it can run.

| | `/plan <task>` | `enter_plan_mode` (model tool) |
| --- | --- | --- |
| Who invokes it | You, explicitly | Pi, on its own initiative for risky/multi-step work |
| Session mode | TUI/RPC only (needs a human to approve) | TUI/RPC, or `print`/`json` with `nonInteractive: true` (plan-only, no approval) |
| How the prompt is delivered | Injected as a new user message | Returned as the tool's own result, in the same turn |

## How it works

- While plan mode is active, mutating tools are blocked until you approve the submitted plan.
- The model can *enter* plan mode but can never *approve* a plan: in an interactive session approval is always an explicit human confirmation.
- The approval overlay is mdview-style: `↑/↓ j/k` scroll, `PgUp/PgDn` page; `y`/`Enter` approve, `n`/`Esc`/`q` reject. When a custom component can't be shown it degrades to a plain `confirm` dialog.
- The read-only gate (see `gate.ts`) allows research only: `read`, `grep`, `find`, `ls`, and read-only shell (`git ls-files`, `git status`, `cat`, `head`, `sed -n`, …). It blocks `write`, `edit`, and mutating shell (`rm`, `mv`, `git commit/add/push/reset`, redirections `>`/`>>`, package installs, …).

## Limitations & safety notes

- The bash allowlist is best-effort and errs toward blocking.
- In non-interactive (plan-only) mode the gate **never lifts**: there is no approval and no implementation for the whole session (see Details).
- Without the non-interactive flag, `print`/`json` sessions refuse to enter plan mode (unchanged back-compat).
- `dynamic_workflow` is gated by action while planning: read-only actions (`list`, `scaffold`, `read`, `graph`, `runs`, `view`) are allowed; `run`, `start`, `resume`, `write`, `cancel`, `delete`, `report` (writes an HTML report to disk), and missing/unknown actions are blocked, because they can write files or spawn mutating subagents whose tool calls bypass the gate.
- Avoid recursion: a plan-only subagent should *name* the workflows to run; the **orchestrator** executes them after approval. Never let a subagent spawn subagents that spawn workflows.

## Details

### Posture flags

Three orthogonal knobs tune plan mode. Ultracode and Ultracode steps resolve with precedence **explicit param → session toggle → environment setting → default (off)**; Non-interactive has no session toggle, so it resolves **explicit param → environment setting → default (off)**:

| Flag | `enter_plan_mode` param | `/plan` flag | Env setting | Effect |
| --- | --- | --- | --- | --- |
| Non-interactive | `nonInteractive` | (tool/env only) | `PI_PLAN_NONINTERACTIVE` | Plan-only: enter even in `print`/`json` (e.g. a workflow subagent). |
| Ultracode | `ultracode` | `--ultracode` | `PI_PLAN_ULTRACODE` | Tell the planner to research/design the plan **with dynamic workflows**. |
| Ultracode steps | `ultracodeSteps` | `--ultracode-steps` | `PI_PLAN_ULTRACODE_STEPS` | Tell the planner/implementer to execute the plan's **steps via dynamic workflows**. |

The `/plan` command is interactive-only, so it does not take `--non-interactive`; non-interactive entry is the `enter_plan_mode` tool's job. The session toggles (`/plan ultracode`, `/plan steps-ultracode`) set an in-memory default for the rest of the session and reset at every session boundary.

### Non-interactive (plan-only) mode

In `print`/`json` sessions there is no human to approve, so plan mode runs plan-only: it arms the read-only gate, the model researches and calls `submit_plan`, and the plan is **returned as the deliverable**. This is what lets a dynamic-workflow subagent produce a plan:

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

Plan-only keeps the gate armed for the whole session, so even if a subagent had `dynamic_workflow` it could not `run`/`start` workflows while planning — only the read-only catalog actions.

### Dynamic workflows in a plan

A plan **may propose running dynamic workflows** (e.g. `action=run`/`start`) as implementation steps for broad, parallel, or high-confidence work: large audits, migrations, exhaustive sweeps, independent verification, deep research. Those execute only **after** you approve the plan and the gate lifts. The planning prompt tells the model this, so it knows the option exists when designing the implementation.

## Related

For the full bundle of extensions and skills, install the repository root instead.
