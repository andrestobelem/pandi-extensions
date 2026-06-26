# pi-dynamic-workflows-core

Individual Pi package for the core Dynamic Workflows extension.

## Install

From this repository:

```bash
pi install ./extensions/pi-dynamic-workflows
pi install -l ./extensions/pi-dynamic-workflows
pi --no-extensions -e ./extensions/pi-dynamic-workflows
```

## Provides

- `dynamic_workflow` model tool for listing, templating, reading, writing, running, resuming, cancelling, graphing, and viewing workflows.
- `/workflow` and `/workflows` human commands.
- `/ultracode`, `/deep-research`, and `/ultracode-mode` routing commands.
- JavaScript workflow runtime with `ctx.agent`, `ctx.agents`, `ctx.pipeline`, `ctx.parallel`, `ctx.workflow`, artifacts, resumable journal, and TUI dashboard.

Stable workflows live in `.pi/workflows/`; drafts and run artifacts live under `.pi/workflows/drafts/` and `.pi/workflows/runs/` for trusted projects.

For `/effort ultracode`, also install `./extensions/pi-effort` or the repository root bundle.
