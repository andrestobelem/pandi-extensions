# parallel

`parallel()` fans out a **fixed, small list of branches** and waits for **all**
of them before a later step runs — a barrier. Reach for it when a step
genuinely needs every branch's result together (merge, dedup, rank), not just
"run these at once."

```js
const [byGrep, bySemantic, byTests] = await parallel([
  () => agent(`Find auth bugs by grep:\n${grepHits}`),
  () => agent(`Find auth bugs by reading the flow:\n${flow}`),
  () => agent(`Find auth bugs implied by failing tests:\n${testLog}`),
]);
const merged = dedupe([byGrep, bySemantic, byTests].filter(Boolean));
```

**Runtime:** shared (pi + Claude Code)

**Signature:** `parallel(thunks) → Promise<results[]>`

- `thunks`: array of zero-arg functions, each returning a promise (typically
  wrapping one or more `agent()` calls).
- Concurrency is capped at `limits.concurrency` automatically — no options
  argument to set it.

## Returns

An array of branch results, aligned to `thunks`. A branch that throws settles
to `null` instead of rejecting the whole batch, so one failure never sinks
the others.

## When to use / not

| Situation | Primitive |
| --- | --- |
| A later step needs ALL branch results at once (merge, dedup, rank, early-exit on combined total) | `parallel` |
| Same one step over a list of independent items | `agents` |
| 2+ dependent stages per item, no cross-branch merge | `pipeline` |

Smell test: `parallel → transform-with-no-cross-item-dependency → parallel`
should be ONE `pipeline`. `map`/`filter`/formatting alone never justify a
barrier.

## Gotchas

- Filter nulls before merging and `log()` how many branches failed.
- Prefer `pipeline` unless a later step genuinely needs ALL results together.
- `thunks` is a fixed list of branches, not a per-item map — for N items use
  `agents` instead.

## Example

```js
const [grepFindings, semanticFindings] = await parallel([
  () => agent(`Find auth bugs by grep:\n${grepHits}`),
  () => agent(`Find auth bugs by reading the flow:\n${flow}`),
]);
const findings = [grepFindings, semanticFindings].filter(Boolean);
log(`parallel: ${findings.length}/2 branches succeeded`);
const report = await agent(`Merge and dedupe these findings:\n${JSON.stringify(findings)}`);
return report;
```
