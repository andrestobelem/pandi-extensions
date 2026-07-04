# @pandi-coding-agent/clear

Adds a Claude-style `/clear` command to Pi. If your fingers type `/clear` out of Claude Code habit, this extension makes it work: it starts a fresh session, exactly like Pi's native `/new`. No config, no flags — install it and the muscle memory just works.

## Usage

```text
/clear
```

Any arguments you pass are ignored; the session is simply reset. On success it is completely silent — no confirmation message, just a clean slate.

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
| `/clear` | Start a fresh session, clearing the conversation. Calls `ctx.newSession()` — the same fresh session as the native `/new`. |

## How it works

- `/clear` coexists with Pi's native `/new` and never overrides it — use whichever verb you prefer.
- Success is strictly silent, in both the TUI and print mode: no confirmation notification either way.
- A cancelled new session (an extension vetoed it via `session_before_switch`) also stays silent; the host already handled the interaction.
- If `newSession` throws, the failure is reported as an error notification (TUI) or printed to stderr (print mode) instead of crashing.

## Related

For the full bundle of extensions and skills, install the repository root instead.
