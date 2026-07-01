# parallel

**Runtime:** shared (pi + Claude Code)

**Signature:** `parallel(thunks) → Promise<results[]>`

A **barrier**: run several branches concurrently and wait for **all** of them so
a later step can consume every result at once. `thunks` is an array of functions
(each returning a promise, typically wrapping one or more `agent()` calls).

**Returns:** an array of branch results, aligned to `thunks` (failed branches
settle to `null` so one branch never sinks the batch).

## When to use / not

- **Use** only for a true barrier: global dedup/merge across branches,
  early-exit when the combined total is zero, or cross-branch ranking.
- **Not** for a plain map (`agents`) or dependent per-item stages (`pipeline`).
  The barrier smell test: `parallel → transform-with-no-cross-item-dependency →
  parallel` should be ONE `pipeline`. `map`/`filter`/formatting alone do not
  justify a barrier.

## Gotchas

- Filter nulls before merging and `log()` how many branches failed.
- Prefer `pipeline` unless a later step genuinely needs ALL results together.

## Example

```js
const [byGrep, bySemantic, byTests] = await parallel([
  () => agent(`Find auth bugs by grep:\n${grepHits}`),
  () => agent(`Find auth bugs by reading the flow:\n${flow}`),
  () => agent(`Find auth bugs implied by failing tests:\n${testLog}`),
]);
const merged = dedupe([byGrep, bySemantic, byTests].filter(Boolean));
```
