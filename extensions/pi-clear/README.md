# pi-dynamic-workflows-clear

Individual Pi package for the `/clear` extension.

## Install

From this repository:

```bash
pi install ./extensions/pi-clear
pi install -l ./extensions/pi-clear
pi --no-extensions -e ./extensions/pi-clear
```

## Provides

- `/clear` — start a fresh session, clearing the conversation. Calls `ctx.newSession()`,
  the same fresh session as the native `/new`. Arguments are ignored.

This mirrors Claude Code's `/clear`, which clears the conversation and starts fresh.

## Relationship to the native `/new`

Pi already ships a native `/new` that starts a new session. `/clear` is a thin **alias**
for the Claude muscle-memory: it coexists with `/new` and never overrides it — use
whichever verb you prefer.

## Behavior details

- A cancelled new session (an extension vetoed it via `session_before_switch`) is left
  silent — the host already handled the interaction.
- If `newSession` throws, the failure is reported as an error notification instead of
  crashing the TUI.
