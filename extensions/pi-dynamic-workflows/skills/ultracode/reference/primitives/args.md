# args

**Runtime:** shared (pi + Claude Code)

**Signature:** `args` (value) — the workflow input

The input passed to the workflow (`dynamic_workflow` `input`, or `Workflow`
`args` on Claude). A top-level script reads it as the `args` global; an
`export default async function main(ctx, input)` also receives it as `input`.

**Returns:** the input value (object, or a JSON string on Claude).

## When to use / not

- **Use** to read the task/config the run was launched with (request, target
  paths, `model`/`effort` budgets, per-role maps).
- **Not** as mutable state — treat it as the run's read-only parameters.

## Gotchas

- **Parse defensively:** on Claude `args` may arrive **JSON-stringified** — guard
  with `typeof args === "string" ? JSON.parse(args) : args`.
- Per-node budgets (`model`, `models`, `efforts`) are conventionally passed inside
  `args`.

## Example

```js
export default async function main() {
  const input = typeof args === "string" ? JSON.parse(args) : (args ?? {});
  const request = input.request ?? "";
  return await agent(request, { model: input.model, effort: input.effort });
}
```
