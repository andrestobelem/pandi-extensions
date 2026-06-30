# pi-dynamic-workflows-goal

Individual Pi package for the `/goal` extension.

## Install

From this repository:

```bash
pi install ./extensions/pi-goal
pi install -l ./extensions/pi-goal
pi --no-extensions -e ./extensions/pi-goal
```

## Provides

- `/goal [--ultracode] <objective> [-- <criteria>]` — start a goal-directed persistent agent loop.
- `/goal status [id]` — inspect active goal state.
- `/goal stop [id]` — stop a goal.
- `goal_progress` model tool for reporting `continue`, `done`, or `blocked`.

`--ultracode` (alias `--uc`) sets an **ultracode posture**: each iteration prompt asks the
model to drive the work via dynamic workflows when it earns its cost (scout inline first,
orchestrate for exhaustiveness/confidence/scale). It is prompt-injection only — it does not
change the thinking level or force-activate `dynamic_workflow`. The flag may appear anywhere
in the args and is stripped from the objective; the posture is persisted and survives reload.

The extension enforces a completeness check before accepting `done` and can run an independent read-only verifier subagent before closing a goal.

For the full bundle of extensions and skills, install the repository root instead.
