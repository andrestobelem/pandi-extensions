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

If the model marks a recommended answer, you can opt into autopicking it:

```text
/ask recommended on          # always choose the recommended answer immediately
/ask recommended-timeout on  # wait 60s, then choose the recommended answer
/ask status                  # show both toggles
```

## Tools

| Tool | Call | Returns |
| --- | --- | --- |
| `ask_choice` | `ask_choice(question, options, recommendedIndex?, recommendedLabel?)` — `options` is a non-empty list of strings, in display order; `recommendedIndex` is 1-based and wins over `recommendedLabel` | JSON `{"index", "label"}` for the chosen option (`index` is 1-based); `{"cancelled": true}` on Esc; `{"index", "label", "recommended": true}` when a recommended toggle chooses for you |
| `ask_confirm` | `ask_confirm(title, message?, recommended?)` — `message` is optional; `recommended` is the suggested boolean answer | JSON `{"confirmed": true \| false}` (also `false` on cancel/timeout); `{"confirmed", "recommended": true}` when a recommended toggle chooses for you |

## Commands

| Command | What it does |
| --- | --- |
| `/ask` or `/ask status` | Show current recommended-mode toggles. |
| `/ask recommended on\|off\|status` | Toggle immediate recommended mode. When on, a valid recommended answer is returned without opening a dialog. |
| `/ask recommended-timeout on\|off\|status` | Toggle delayed recommended mode. When on, a valid recommended answer is used after 60 seconds without a user choice. |

If both toggles are on, immediate recommended mode wins. If a tool call has no valid
recommended answer, behavior falls back to the normal interactive dialog.

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
  in text. If delayed recommended mode is on and a valid recommended answer is present,
  the recommended answer is returned instead.
- `ask_choice` with an empty `options` list also returns a plain-text error instead of
  opening a dialog.
- In delayed recommended mode, manual Esc/cancel before the 60s timeout still counts as
  cancellation for `ask_choice`; the recommended option is used only when the timeout
  dismisses the dialog.

## Related

For the full bundle of extensions and skills, install the repository root instead.
