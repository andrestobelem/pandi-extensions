# @pandi-coding-agent/loop

Keep a task running turn after turn without re-prompting it yourself: `/loop`
re-injects the next iteration on its own, at a cadence the model picks or one
you fix, until it (or you) calls it done. Reach for it for multi-pass jobs —
polling a CI run, iterating on a fix, watching a slow process.

## Quickstart

```bash
pi install npm:@pandi-coding-agent/loop
```

```text
/loop "watch the CI run and tell me when it's green"
```

This starts a **dynamic** loop: it runs one pass immediately, then the model
calls the `loop_schedule` tool to pick the next wakeup (clamped to 60s-1h) —
no fixed timer, no manual re-prompting. Stop it anytime with `/loop stop`.

From this repo instead of npm: `pi install ./extensions/pi-loop` (add `-l`
for project-local, or `pi --no-extensions -e ./extensions/pi-loop` to trial it
alone).

## Choosing a mode

| Mode | Start with | Cadence | Use when |
| --- | --- | --- | --- |
| Dynamic | `/loop <task>` | Model picks each wakeup (60s-1h) | Pace is unpredictable |
| Fixed | `/loop <task> <interval>` | You set the period, e.g. `10m` | You know how often to check |
| Autonomous | `/loop auto <objective> [interval]` | Same as above | Unattended, on a trusted project, after you confirm once |

## Commands

| Command | What it does |
| --- | --- |
| `/loop [--ultracode] <task>` | Start a dynamic loop; the model schedules each wakeup. |
| `/loop [--ultracode] <task> <interval>` | Start a fixed-interval loop, e.g. `10m` or `1h`. |
| `/loop auto [--ultracode] <objective> [interval]` | Start a trusted autonomous loop after you confirm. |
| `/loop status\|pause\|resume\|stop [id]` | Manage running loops. |
| `loop_schedule` | Model tool: schedule the next wakeup in dynamic mode (no-op in fixed mode). |
| `loop_stop` | Model tool: stop the loop that owns the current turn. |

`--ultracode` (alias `--uc`) is parsed before the trailing interval token, so
`--ultracode <task> 5m` keeps both; it only nudges iterations to lean on
dynamic workflows when that earns its cost, never forcing one.

## How it works & safety

- State persists across reloads; wakeups are serialized to one autopilot turn
  at a time, even with several loops active.
- Caps stop a loop before it re-arms: max iterations (25 default), a
  wall-clock deadline (6h default), a context-usage cap (90% default) — and a
  25h watchdog backstop beyond that. The deadline uses `Date.now()`, not a
  monotonic clock, so a backward clock jump only delays it.
- During an autopilot turn, a destructive-action gate confirms (with a UI) or
  blocks (without one) calls matching a conservative allowlist: recursive
  `rm`, force pushes, `git reset --hard`, SQL drops, out-of-project writes.
- `/loop auto` needs a trusted project **and** an explicit confirmation;
  sessions without a UI refuse it, and a rehydrated autonomous loop is
  retired (not resumed) if the project has since lost trust.

## Related

For the full bundle of extensions and skills, install the repository root instead.
