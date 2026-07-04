# @pandi-coding-agent/goal

Run a goal-directed persistent agent loop with `/goal`: Pi keeps iterating toward an objective, must pass a completeness check before claiming `done`, and can be independently verified by a read-only subagent before the goal closes.

## What you get

- A `/goal` loop that re-prompts the model each iteration until the objective is met, blocked, or stopped.
- A completeness check: the first `done` does not stop the goal — it triggers a verification pass, and only a confirmed `done` closes it.
- An independent read-only verifier subagent (tools: `read`, `grep`, `find`, `ls`; 120 s timeout) that must PASS before the goal is finally accepted; after 2 failed verifications the goal stops as `blocked`.
- Safety limits: 30 iterations max and a context-budget cut at 90% usage by default.

## Install

From npm:

```bash
pi install npm:@pandi-coding-agent/goal
```

From this repository:

```bash
pi install ./extensions/pi-goal          # global (your user)
pi install -l ./extensions/pi-goal       # project-local
pi --no-extensions -e ./extensions/pi-goal   # one-off trial, nothing else loaded
```

## Commands

| Command | What it does |
| --- | --- |
| `/goal [--ultracode] <objective> [-- <criteria>]` | Start a goal-directed loop; optional success criteria after `--`. |
| `/goal status [id]` | Inspect active goal state. |
| `/goal stop [id]` | Stop a goal. |
| `goal_progress` | Model tool: the model reports `continue`, `done`, or `blocked` each iteration. |

## How it works

- `--ultracode` (alias `--uc`) sets an **ultracode posture**: each iteration prompt asks the model to drive the work via dynamic workflows when it earns its cost (scout inline first, orchestrate for exhaustiveness, confidence, or scale). It is prompt-injection only — it does not change the thinking level or force-activate `dynamic_workflow`. The flag may appear anywhere in the args and is stripped from the objective.
- Goal state is persisted and survives session reload; a rehydrated goal resumes without double-firing.
- When a verified `done` would close the goal, the extension launches the independent verifier (separate process, fresh eyes). A FAIL under the cap re-injects one iteration carrying the verifier's feedback; a FAIL at the cap stops the goal as `blocked` for a human.

## Limitations & safety notes

- Only one goal can be active at a time; stop the current one before starting another.
- `/goal` requires a TUI or RPC session — it cannot run in other modes.
- A goal stops when it hits `maxIterations` (30) or the context budget (90% usage); after a budget stop you can `/compact` and start again.

## Related

For the full bundle of extensions and skills, install the repository root instead.
