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

- `/loop <task>` — start a dynamic iterative task loop.
- `/loop <task> <interval>` — start a fixed-interval loop such as `10m` or `1h`.
- `/loop auto <task> [interval]` — start a trusted autonomous loop after confirmation.
- `/loop status|pause|resume|stop [id]` — manage loops.
- `loop_schedule` and `loop_stop` model tools.

The extension persists loop state, serializes wakeups, and guards destructive autopilot tool calls.

For the full bundle of extensions and skills, install the repository root instead.
