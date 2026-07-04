# pipeline

`pipeline` runs each item through the **same sequence of dependent steps**,
one item at a time through its own chain — no merging across items. Reach
for it whenever a task looks like "for each item: step 1, then step 2, then
step 3" (e.g. classify → deep-review → summarize).

```js
const summaries = await pipeline(
  files,
  (f) => agent(`Classify risk of ${f}`, { model: "haiku", effort: "low", name: `classify:${f}` }),
  (risk, f) => agent(`Given risk ${risk}, deep-review ${f}`, { model: "sonnet", effort: "high", name: `review:${f}` }),
);
log(`reviewed ${summaries.filter(Boolean).length}/${files.length}`);
```

**Runtime:** shared (pi + Claude Code)

**Signature:** `pipeline(items, ...stages, [options]) → Promise<(result | null)[]>`

Each stage is called as `stage(value, originalItem, index)`: `value` is the
previous stage's output for that item (the raw item on the first stage),
`originalItem`/`index` are always the untouched original item and its
position — handy for ids in prompts even deep in the chain. Items run
concurrently up to the workflow's `concurrency` limit; pass `{ inFlight: n }`
as a trailing options object to cap it lower for this call. Max 4096 items
per call (chunk larger work-lists yourself).

**Returns:** an array aligned to `items`; each entry is the last stage's
output for that item, or `null` if any stage threw for it — failed items
never sink the batch.

## When to use / not

| Situation | Use |
| --- | --- |
| Same N dependent steps per item, items independent | `pipeline` (default for multi-stage per-item work) |
| One step per item | `agents` |
| A later step needs ALL items at once (e.g. rank/dedupe together) | `parallel` |
| N alternative approaches to the same item, keep the first good one | `race` |

## Gotchas

- Put a **stable item id/index** into prompts generated inside stages — use
  the `originalItem`/`index` stage args, not just the running `value` (cache
  + resume correctness).
- Failed items are `null`, not thrown — `filter(Boolean)` and `log()` the
  count before any final merge, or a silent drop looks like success.
- `{ inFlight }` only lowers concurrency for this call; it can never exceed
  the workflow's own `limits.concurrency`.

## Example

```js
export default async function main() {
  const files = ["src/a.ts", "src/b.ts", "src/c.ts"];
  const results = await pipeline(
    files,
    (f) => agent(`Classify risk of ${f}`, { model: "haiku", effort: "low" }),
    (risk, f, i) => agent(`Given risk ${risk}, deep-review ${f} (#${i})`, { model: "sonnet", effort: "high" }),
    { inFlight: 3 },
  );
  const ok = results.filter(Boolean);
  log(`reviewed ${ok.length}/${files.length}`);
  return ok;
}
```
