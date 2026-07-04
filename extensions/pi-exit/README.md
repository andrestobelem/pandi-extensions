# @pandi-coding-agent/exit

Leave Pi with a Claude-style `/exit` command — a thin alias for the native `/quit` clean shutdown. Reach for it when Claude Code muscle memory makes you type `/exit` and Pi only knows `/quit`.

## Quickstart

```bash
pi install npm:@pandi-coding-agent/exit
```

Then, in any session:

```text
> /exit
```

That runs the same clean shutdown as `/quit`. Arguments are ignored.

## Other ways to install

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

- `/exit` mirrors Claude Code, where `/exit` (and `/quit`) leaves the session. It coexists with Pi's native `/quit` and never overrides it — use whichever verb you prefer.
- Success is strictly silent, in both the TUI and print mode: no confirmation notification either way.
- `ctx.shutdown()` delegates to a mode-provided shutdown handler that can throw synchronously. That call is guarded, so a throwing `ctx.shutdown()` is reported as an error notification (TUI) or printed to stderr (print mode) — `exit failed: ...` — instead of crashing or leaking a generic extension error.

## Related

For the full bundle of extensions and skills, install the repository root instead.
