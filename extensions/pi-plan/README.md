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
- `submit_plan` model tool for submitting a plan artifact for explicit approval.

While plan mode is active, mutating tools are blocked until the user approves the submitted plan.

For the full bundle of extensions and skills, install the repository root instead.
