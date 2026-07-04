# @pandi-coding-agent/pandi-ask

Interactive decision tools the model can call to ask *you* — an arrow-key picker and a
yes/no dialog, instead of a plain-text numbered menu. They wrap pi's dialog helpers
(`ctx.ui.select` / `ctx.ui.confirm`), so they work in both TUI and RPC modes.

## Quickstart

Install once:

```bash
pi install npm:@pandi-coding-agent/pandi-ask
```

Then the model can call `ask_choice` mid-conversation. You pick with `↑↓` + Enter, and
it gets back:

```json
{ "index": 1, "label": "Patch the bug" }
```

## Tools

| Tool | Call | Returns |
| --- | --- | --- |
| `ask_choice` | `ask_choice(question, options)` — `options` is a non-empty list of strings, in display order | JSON `{"index", "label"}` for the chosen option (`index` is 1-based); `{"cancelled": true}` on Esc |
| `ask_confirm` | `ask_confirm(title, message?)` — `message` is an optional secondary detail line | JSON `{"confirmed": true \| false}` (also `false` on cancel/timeout) |

## Other install options

From this repository:

```bash
pi install ./extensions/pandi-ask          # global (your user)
pi install -l ./extensions/pandi-ask       # project-local
pi --no-extensions -e ./extensions/pandi-ask   # one-off trial, nothing else loaded
```

## Limitations & safety notes

- When no dialog UI is available (`ctx.hasUI` is false — e.g. `print`/`json` mode), both
  tools open no dialog and return a plain-text error, so the caller falls back to asking
  in text.
- `ask_choice` with an empty `options` list also returns a plain-text error instead of
  opening a dialog.

## Related

For the full bundle of extensions and skills, install the repository root instead.
