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

- `/goal <objective> [-- <criteria>]` — start a goal-directed persistent agent loop.
- `/goal status [id]` — inspect active goal state.
- `/goal stop [id]` — stop a goal.
- `goal_progress` model tool for reporting `continue`, `done`, or `blocked`.

The extension enforces a completeness check before accepting `done` and can run an independent read-only verifier subagent before closing a goal.

For the full bundle of extensions and skills, install the repository root instead.
