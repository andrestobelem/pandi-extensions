# @pandi-coding-agent/clear

Adds a Claude-style `/clear` command to Pi that starts a fresh session — a thin alias for the native `/new`, for Claude muscle-memory.

## Install

From npm:

```bash
pi install npm:@pandi-coding-agent/clear
```

From this repository:

```bash
pi install ./extensions/pi-clear          # global (your user)
pi install -l ./extensions/pi-clear       # project-local
pi --no-extensions -e ./extensions/pi-clear   # one-off trial, nothing else loaded
```

## Commands

| Command | What it does |
| --- | --- |
| `/clear` | Start a fresh session, clearing the conversation. Calls `ctx.newSession()` — the same fresh session as the native `/new`. Arguments are ignored. |

## How it works

- `/clear` coexists with Pi's native `/new` and never overrides it — use whichever verb you prefer.
- A cancelled new session (an extension vetoed it via `session_before_switch`) stays silent; the host already handled the interaction.
- If `newSession` throws, the failure is reported as an error notification instead of crashing the TUI.

## Related

For the full bundle of extensions and skills, install the repository root instead.
