# @pandi-coding-agent/ask

Interactive decision tools the model can call to ask *you* — an arrow-key picker and a yes/no dialog instead of a plain-text numbered menu. They wrap pi's dialog helpers (`ctx.ui.select` / `ctx.ui.confirm`), so they work in both TUI and RPC/Supacode.

## Install

From npm:

```bash
pi install npm:@pandi-coding-agent/ask
```

From this repository:

```bash
pi install ./extensions/pi-ask          # global (your user)
pi install -l ./extensions/pi-ask       # project-local
pi --no-extensions -e ./extensions/pi-ask   # one-off trial, nothing else loaded
```

## Usage

| Tool | What it does |
| --- | --- |
| `ask_choice(question, options)` | Model tool: shows an arrow-key selector (`↑↓` + Enter); returns JSON `{"index", "label"}` (`index` is 1-based, matching the displayed numbering), or `{"cancelled": true}` on Esc. |
| `ask_confirm(title, message?)` | Model tool: shows a yes/no confirm dialog; returns JSON `{"confirmed": true}` or `{"confirmed": false}` (also `false` on cancel/timeout). |

Example `ask_choice` result:

```json
{ "index": 2, "label": "Fix only the docs" }
```

## Limitations & safety notes

- When no dialog UI is available (`ctx.hasUI` is false — e.g. `print`/`json` mode), both tools open no dialog and return a plain-text error, so the caller falls back to asking in text.

## Related

For the full bundle of extensions and skills, install the repository root instead.
