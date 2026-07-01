# ask

**Runtime:** pi runtime (not on the Claude Code Workflow tool)

**Signature:** `ask(question, options?) → Promise<string | boolean>`

Pause a branch and ask the human via Pi's UI. The `kind` is inferred from the
options: `input` (free text), `confirm` (yes/no), or `select` (from `choices`).
`options` include `choices`, `default`, and `signal` (so a `race()` loser's
dialog is dismissed).

**Returns:** a **string** for `input`/`select`, a **boolean** for `confirm`.

## When to use / not

- **Use** for a genuine human-in-the-loop decision/approval mid-run — in
  **user-authored drafts**, not the autonomous catalog scaffolds.
- **Not** in cross-runtime scaffolds (pi-only) and not for scaffolds designed to
  run end-to-end unattended (those infer instead of pausing; see `contract-gate`).

## Gotchas

- **Resume-safe:** the answer is journaled and replayed on resume — never
  re-asked.
- **Headless-honest:** with `hasUI:false` it uses `options.default` or throws a
  clear error — it never hangs. Unlike `agent()`, `ask()` does **not** swallow
  errors: a host error rejects (surfaces as a thrown error).
- Cancellable inside `race()` via `{ signal }`.

## Example

```js
const proceed = await ask("Apply the migration to all 200 files?", {
  default: false, // headless → no
});
if (!proceed) return { skipped: true };
```
