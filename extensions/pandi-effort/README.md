# @pandi-coding-agent/pandi-effort

This extension adds a Claude-style `/effort` slash command so you can change how
hard Pi thinks — from `off` to `xhigh` — without hunting through settings.
Reach for it when a task needs deeper reasoning (bump to `high`/`xhigh`) or
when you want faster, cheaper turns (drop to `low`/`off`). One special value,
`ultracode`, sets `xhigh` and turns on the Dynamic Workflows router in a
single command.

```text
/effort high
→ Thinking effort set to high.

/effort ultracode
→ Ultracode effort enabled (xhigh); dynamic workflow router enabled.
```

## Install

From npm:

```bash
pi install npm:@pandi-coding-agent/pandi-effort
```

From this repository:

```bash
pi install ./extensions/pandi-effort          # global (your user)
pi install -l ./extensions/pandi-effort       # project-local
pi --no-extensions -e ./extensions/pandi-effort   # one-off trial, nothing else loaded
```

## Commands

| Command | What it does |
| --- | --- |
| `/effort` | Open an interactive picker of effort levels. |
| `/effort status` | Show the current thinking effort. |
| `/effort off\|minimal\|low\|medium\|high\|xhigh` | Set Pi's thinking level (`none` and `max` are aliases for `off` and `xhigh`). |
| `/effort ultracode` | Set `xhigh` and enable the Dynamic Workflows Ultracode router (when that extension is loaded). |

## Limitations & safety notes

- `/effort ultracode` routing needs the `pandi-dynamic-workflows` extension — install `./extensions/pandi-dynamic-workflows` or the repository root bundle.
- Lowering thinking afterwards (e.g. `/effort medium`) does **not** turn the Ultracode router off — they are separate concerns. Disable the router with `/ultracode-mode off`.
- The active model may clamp the requested level (non-reasoning models become `off`); the command reports the level that actually took effect.

## Related

For the full bundle of extensions and skills, install the repository root instead.
