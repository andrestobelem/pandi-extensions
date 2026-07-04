# @pandi-coding-agent/loop

Run a task on a loop with `/loop` — dynamic or fixed-interval cadence, pause/resume controls, and safety gates on autonomous iterations.

## What you get

- Iterative loops where the model decides the next wakeup, or fixed intervals like `10m` / `1h`.
- Full lifecycle control: `status`, `pause`, `resume`, `stop`, per loop id.
- Autonomous mode (`/loop auto`) gated by project trust plus an explicit confirmation.
- A destructive-action gate that guards autopilot turns against irreversible tool calls.

## Install

From npm:

```bash
pi install npm:@pandi-coding-agent/loop
```

From this repository:

```bash
pi install ./extensions/pi-loop          # global (your user)
pi install -l ./extensions/pi-loop       # project-local
pi --no-extensions -e ./extensions/pi-loop   # one-off trial, nothing else loaded
```

## Commands

| Command | What it does |
| --- | --- |
| `/loop [--ultracode] <task>` | Start a dynamic iterative loop; the model schedules each wakeup. |
| `/loop [--ultracode] <task> <interval>` | Start a fixed-interval loop, e.g. `10m` or `1h`. |
| `/loop auto [--ultracode] <task> [interval]` | Start a trusted autonomous loop after you confirm. |
| `/loop status\|pause\|resume\|stop [id]` | Manage running loops. |
| `loop_schedule` | Model tool: schedule the next wakeup in dynamic mode (no-op in fixed mode). |
| `loop_stop` | Model tool: stop the loop that owns the current turn. |

## How it works

- The extension persists loop state, serializes wakeups (one autopilot turn at a time), and re-arms on reload.
- `--ultracode` (alias `--uc`) sets an ultracode posture: each iteration prompt asks the model to drive the work via dynamic workflows when that earns its cost (scout inline first, orchestrate for exhaustiveness, confidence, or scale). It is prompt-injection only — it does not change the thinking level and does not force-activate `dynamic_workflow`.
- The flag is parsed before the trailing interval token (so `--ultracode <task> 5m` keeps both), stripped from the task, and persisted so the posture survives a reload.
- Caps stop a loop before it re-arms: a max wall-clock deadline, a context-usage percent cap, and a max-iterations gate. A watchdog force-stops loops that blow past a hard deadline.

## Limitations & safety notes

- `/loop auto` requires a trusted project **and** an explicit interactive confirmation; sessions without a UI refuse it. If the project loses trust, a rehydrated autonomous loop is retired instead of resumed.
- While an autopilot turn is active, destructive tool calls matching a conservative allowlist (recursive `rm`, force pushes, `git reset --hard`, SQL drops, out-of-project write redirections, and similar) are confirmed when a UI exists or blocked otherwise.
- The wall-clock deadline uses `Date.now()`, not a monotonic clock, so it survives restarts; a backward clock jump only delays the cap by the jump size.

## Related

For the full bundle of extensions and skills, install the repository root instead.
