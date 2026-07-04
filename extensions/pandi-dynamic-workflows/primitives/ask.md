# ask

Pauses a branch to get a decision from a human, mid-run. Reach for it when
the workflow itself cannot safely decide — a risky action needs sign-off, or
a choice depends on judgment the model doesn't have.

```js
const proceed = await ask("Apply the migration to all 200 files?", {
  default: false, // headless fallback: no UI → answer "no"
});
if (!proceed) return { skipped: true };
```

**Runtime:** pi runtime (not on the Claude Code Workflow tool)

**Signature:** `ask(question, options?) → Promise<string | boolean>`

`options.kind` picks the dialog: `input` (free text, default), `confirm`
(yes/no — inferred when `default` is boolean), or `select` (from
`choices` — inferred when `choices` is set). Other options: `placeholder`,
`default`, `timeoutMs`, `cache` (default `true`), `secret` (never
persisted/replayed), and `signal` (so a `race()` loser's dialog is
dismissed).

**Returns:** a **string** for `input`/`select`, a **boolean** for `confirm`.

## When to use / not

| Situation | Use `ask()`? |
| --- | --- |
| A user-authored draft needs a human approval gate mid-run | Yes |
| An autonomous catalog scaffold meant to run unattended | No — infer instead (see `contract-gate`) |
| A cross-runtime scaffold (must also run on Claude Code Workflow) | No — pi-only primitive |
| Loser dialog inside a `race()` | Yes, pass `{ signal }` to auto-dismiss |

## Gotchas

- **Resume-safe:** the answer is journaled by `(key, occ)` and replayed on
  resume — never re-asked, unless `cache: false`.
- **Headless-honest:** with `hasUI:false` it uses `options.default` or
  throws a clear error — it never hangs. Unlike `agent()`, `ask()` does
  **not** swallow errors: a host error rejects (surfaces as a thrown error).
- **Ambiguous kind:** passing both `choices` and a boolean `default` throws —
  set `options.kind` explicitly to disambiguate.
- **`select` needs its default in `choices`**, and `choices` must be a
  non-empty array.
- `secret: true` skips the journal entirely — the answer is never written
  to disk, and it will be re-asked on resume.

## Example

```js
export default async function main(ctx, input) {
  const proceed = await ask(`Deploy ${input.target} to production?`, {
    kind: "confirm",
    default: false,
  });
  if (!proceed) return { skipped: true, reason: "declined by human" };
  const result = await agent(`Run the deployment for ${input.target}`);
  return { deployed: true, result };
}
```
