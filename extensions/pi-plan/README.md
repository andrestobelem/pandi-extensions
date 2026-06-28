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

- `/plan <task>` — enter read-only plan mode for a task.
- `/plan status` — inspect the active plan.
- `/plan exit|cancel` — leave plan mode without implementing.
- `enter_plan_mode` model tool: lets Pi enter plan mode **on its own** before a non-trivial,
  multi-step, or risky change (not only when a human types `/plan`). It arms the same read-only
  gate and hands the planning instruction back as its result; the human still approves.
- `submit_plan` model tool for submitting a plan artifact for explicit approval.

While plan mode is active, mutating tools are blocked until the user approves the submitted plan.
The model can *enter* plan mode (`enter_plan_mode`) but can never *approve* a plan: approval is
always an explicit human confirmation. In non-interactive (`print`/`json`) sessions both entry
paths refuse, since the approval handshake cannot run there.

## Read-only gate

While planning, the gate (see `gate.ts`) hard-blocks mutation and allows only research:

- **Allowed:** `read`, `grep`, `find`, `ls`, and read-only shell (`git ls-files`, `git status`,
  `cat`, `head`, `sed -n` …).
- **Blocked:** `write`, `edit`, and mutating shell (`rm`, `mv`, `git commit/add/push/reset`,
  redirections `>`/`>>`, package installs …). The bash allowlist is best-effort and errs toward
  blocking.

### Dynamic workflows in a plan

`dynamic_workflow` is gated by **action**:

- **Allowed while planning (read-only):** `list`, `template`, `read`, `graph`, `runs`, `view` —
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
