# @pandi-coding-agent/exit

Leave Pi with a Claude-style `/exit` command — a thin alias for the native `/quit` clean shutdown.

## Install

From npm:

```bash
pi install npm:@pandi-coding-agent/exit
```

From this repository:

```bash
pi install ./extensions/pi-exit          # global (your user)
pi install -l ./extensions/pi-exit       # project-local
pi --no-extensions -e ./extensions/pi-exit   # one-off trial, nothing else loaded
```

## Commands

| Command | What it does |
| --- | --- |
| `/exit` | Exit Pi cleanly via `ctx.shutdown()` — the same clean shutdown as the native `/quit`. Arguments are ignored. |

## How it works

`/exit` mirrors Claude Code, where `/exit` (and `/quit`) leaves the session. It coexists with Pi's native `/quit` and never overrides it — use whichever verb you prefer.

## Related

For the full bundle of extensions and skills, install the repository root instead.
