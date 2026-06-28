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

For the full bundle of extensions and skills, install the repository root instead.
