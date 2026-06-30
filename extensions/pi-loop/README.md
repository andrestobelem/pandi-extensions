# pi-dynamic-workflows-loop

Individual Pi package for the `/loop` extension.

## Install

From this repository:

```bash
pi install ./extensions/pi-loop
pi install -l ./extensions/pi-loop
pi --no-extensions -e ./extensions/pi-loop
```

## Provides

- `/loop [--ultracode] <task>` — start a dynamic iterative task loop.
- `/loop [--ultracode] <task> <interval>` — start a fixed-interval loop such as `10m` or `1h`.
- `/loop auto [--ultracode] <task> [interval]` — start a trusted autonomous loop after confirmation.
- `/loop status|pause|resume|stop [id]` — manage loops.
- `loop_schedule` and `loop_stop` model tools.

`--ultracode` (alias `--uc`) sets an **ultracode posture**: each iteration prompt asks the
model to drive the work via dynamic workflows when it earns its cost (scout inline first,
orchestrate for exhaustiveness/confidence/scale). It is prompt-injection only — it does not
change the thinking level or force-activate `dynamic_workflow`. The flag is parsed before the
trailing interval token (so `--ultracode <task> 5m` keeps both), stripped from the task, and
persisted so the posture survives reload.

The extension persists loop state, serializes wakeups, and guards destructive autopilot tool calls.

For the full bundle of extensions and skills, install the repository root instead.
