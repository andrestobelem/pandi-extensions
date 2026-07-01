# pi-ask

Interactive **decision tools** the model can call to ask *you* — instead of printing a
plain-text numbered menu. The assistant produces text and tool calls; it cannot pop a TUI
selector from a reply. These tools wrap pi's dialog helpers (`ctx.ui.select` /
`ctx.ui.confirm`, which work in **TUI and RPC/Supacode**) so a decision point becomes an
interactive picker and the choice is read back into the conversation.

## Tools

### `ask_choice(question, options)`

Shows an arrow-key selector (`↑↓` + Enter). Returns JSON:

```json
{ "index": 2, "label": "Corregir solo los docs" }
```

`index` is **1-based** (matches the displayed numbering). On cancel (Esc) it returns
`{ "cancelled": true }`.

### `ask_confirm(title, message?)`

Shows a yes/no confirm dialog. Returns JSON `{ "confirmed": true }` or
`{ "confirmed": false }` (also `false` on cancel/timeout).

## Non-interactive modes

When no dialog UI is available (`ctx.hasUI` is false — e.g. `print`/`json` mode), both
tools open **no** dialog and return a plain-text error, so the caller falls back to asking
in text.

## Install

```bash
pi install ./extensions/pi-ask          # or the whole bundle: pi install ./
```

Part of the [pi-dynamic-workflows](../../README.md) harness.
