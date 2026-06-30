# pi-dynamic-workflows-exit

Individual Pi package for the `/exit` extension.

## Install

From this repository:

```bash
pi install ./extensions/pi-exit
pi install -l ./extensions/pi-exit
pi --no-extensions -e ./extensions/pi-exit
```

## Provides

- `/exit` — exit pi cleanly. Calls `ctx.shutdown()`, the same clean shutdown as the
  native `/quit`. Arguments are ignored.

This mirrors Claude Code, where `/exit` (and `/quit`) leaves the session.

## Relationship to the native `/quit`

Pi already ships a native `/quit` that shuts down cleanly. `/exit` is a thin **alias**
for the Claude muscle-memory: it coexists with `/quit` and never overrides it — use
whichever verb you prefer.
