# pipeline

**Runtime:** shared (pi + Claude Code)

**Signature:** `pipeline(items, ...stages) → Promise<(result | null)[]>`

Run **2+ dependent stages per item**, with no cross-item merge. Each `item`
flows through the stages independently and in order; a stage receives the
previous stage's output for that item. This is the **default** for multi-stage
per-item work — not a barrier.

**Returns:** an array aligned to `items`; each entry is the last stage's output
for that item, or `null` if any stage failed for it (failed items become `null`,
they never sink the batch).

## When to use / not

- **Use** when every item needs the same sequence of steps (e.g. classify →
  deep-review → summarize) and items don't need to see each other.
- **Not** when a later step needs ALL items at once (use `parallel`) or when it's
  a single step (use `agents`).

## Gotchas

- Put a **stable item id/index** into prompts generated inside stages (cache +
  resume correctness).
- Failed items are `null` — filter and `log()` the count before any final merge.

## Example

```js
const summaries = await pipeline(
  files,
  (f) => agent(`Classify risk of ${f}`, { model: "haiku", effort: "low", name: `classify:${f}` }),
  (risk, f) => agent(`Given risk ${risk}, deep-review ${f}`, { model: "sonnet", effort: "high", name: `review:${f}` }),
);
log(`reviewed ${summaries.filter(Boolean).length}/${files.length}`);
```
