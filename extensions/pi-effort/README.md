# @pandi-coding-agent/effort

Individual Pi package for the `/effort` extension.

## Install

From this repository:

```bash
pi install ./extensions/pi-effort
pi install -l ./extensions/pi-effort
pi --no-extensions -e ./extensions/pi-effort
```

## Provides

- `/effort status` — show current thinking effort.
- `/effort off|minimal|low|medium|high|xhigh` — set Pi thinking level.
- `/effort ultracode` — request `xhigh` and enable the Dynamic Workflows Ultracode router when that extension is loaded.

For `/effort ultracode` routing, also install `./extensions/pi-dynamic-workflows` or the repository root bundle.

Lowering thinking afterwards with `/effort <level>` (e.g. `/effort medium`) does **not** turn the Ultracode router off — these are separate concerns. To disable the router, use `/ultracode-mode off`.
