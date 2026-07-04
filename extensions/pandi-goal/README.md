# @pandi-coding-agent/pandi-goal

`/goal` turns Pi into a goal-directed agent: instead of a single turn, it
keeps iterating toward an objective across many turns until the work is
**verified** complete — not just self-declared done. Reach for it when a task
needs multiple iterations and you want a built-in completeness check plus an
independent double-check before it's marked finished.

```text
/goal Add rate limiting to the login endpoint -- 429 after 5 failed attempts in 60s, unit test covers it
```

Pi iterates, self-assesses against the criteria via the `goal_progress` tool,
and only closes the goal once a separate read-only subagent independently
confirms it. Check on it anytime with `/goal status`.

## What you get

- A `/goal` loop that re-prompts the model each iteration until the objective is met, blocked, or stopped.
- A completeness check: the first `done` does not stop the goal — it triggers a verification pass, and only a confirmed `done` closes it.
- An independent read-only verifier subagent (tools: `read`, `grep`, `find`, `ls`; 120 s timeout) that must PASS before the goal is finally accepted; after 2 failed independent verifications the goal stops as `blocked`.
- Safety limits: 30 iterations max and a context-budget cut at 90% usage by default.

## Install

From npm:

```bash
pi install npm:@pandi-coding-agent/pandi-goal
```

From this repository:

```bash
pi install ./extensions/pandi-goal          # global (your user)
pi install -l ./extensions/pandi-goal       # project-local
pi --no-extensions -e ./extensions/pandi-goal   # one-off trial, nothing else loaded
```

## Commands

| Command | What it does |
| --- | --- |
| `/goal [--ultracode] <objective> [-- <criteria>]` | Start a goal-directed loop; optional success criteria after `--`. |
| `/goal status [id]` | Inspect active goal state. |
| `/goal stop [id]` | Stop a goal. |
| `goal_progress` | Model tool: the model reports `continue`, `done`, or `blocked` each iteration. |

## `/goal` vs `/loop`

Both re-inject a prompt without native scheduling, but they answer different
questions — pick by what you're driving:

| | `/goal` | `/loop` |
| --- | --- | --- |
| Driven by | an OBJECTIVE + success criteria | a TASK repeated on a cadence |
| Model reports | `continue` / `done` / `blocked` | when to wake next (`delaySeconds`) |
| Ends when | criteria met **and** independently verified | never on its own — you `/loop stop` it |

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
