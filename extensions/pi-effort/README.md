# @pandi-coding-agent/effort

Switch Pi's thinking level with a Claude-style `/effort` command — from `off` to `xhigh`, plus `ultracode` to enable the Dynamic Workflows router.

## Install

From npm:

```bash
pi install npm:@pandi-coding-agent/effort
```

From this repository:

```bash
pi install ./extensions/pi-effort          # global (your user)
pi install -l ./extensions/pi-effort       # project-local
pi --no-extensions -e ./extensions/pi-effort   # one-off trial, nothing else loaded
```

## Commands

| Command | What it does |
| --- | --- |
| `/effort` | Open an interactive picker of effort levels. |
| `/effort status` | Show the current thinking effort. |
| `/effort off\|minimal\|low\|medium\|high\|xhigh` | Set Pi's thinking level (`none` and `max` are aliases for `off` and `xhigh`). |
| `/effort ultracode` | Set `xhigh` and enable the Dynamic Workflows Ultracode router (when that extension is loaded). |

## Limitations & safety notes

- `/effort ultracode` routing needs the `pi-dynamic-workflows` extension — install `./extensions/pi-dynamic-workflows` or the repository root bundle.
- Lowering thinking afterwards (e.g. `/effort medium`) does **not** turn the Ultracode router off — they are separate concerns. Disable the router with `/ultracode-mode off`.
- The active model may clamp the requested level (non-reasoning models become `off`); the command reports the level that actually took effect.

## Related

For the full bundle of extensions and skills, install the repository root instead.
