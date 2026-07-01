# workflow

**Runtime:** shared (pi + Claude Code)

**Signature:** `workflow(name, args) → Promise<result>`

Compose a **reusable sub-workflow inline**: call another catalog/library workflow
by name and get its return value, without a human decision gate in between.
Prefer composing an existing scaffold over re-implementing it.

**Returns:** the sub-workflow's returned value.

## When to use / not

- **Use** for a reusable sub-step with **no decision gate** (e.g. a `*-lib`
  verifier called by `composition-driver`).
- **Not** when you must inspect the sub-result before deciding the next phase —
  run separate workflows sequentially instead.

## Gotchas

- **Depth-bounded.** Claude Code allows **depth 1** (a child's `workflow()`
  throws — only the top level composes). pi defaults to **depth 2**, configurable
  to 3 via `PI_DYNAMIC_WORKFLOWS_MAX_DEPTH`. Beyond the limit the runtime refuses
  (recursion guard) — design within the budget.
- Declare provenance: set `meta.basedOn` for every scaffold you compose.

## Example

```js
// inside a driver workflow
const verified = await workflow("verify-claims-lib", { claims, evidence });
return verified.filter((c) => c.status === "confirmed");
```
