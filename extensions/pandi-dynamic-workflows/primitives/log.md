# log

`log()` writes one line to the run's event log — the same timeline you see in
`/workflow view` and the dashboard. Use it so anyone inspecting the run later
can tell what happened, without re-running anything.

```js
const results = await agents(items, { concurrency: 8, settle: true });
const failed = results.filter((r) => r == null).length;
log(`fan-out: ${results.length - failed}/${results.length} ok, ${failed} failed`);
```

**Runtime:** shared (pi + Claude Code)

**Signature:** `log(...args) → void`

Non-string args are compacted before being joined into one line.

**Returns:** nothing.

## When to use / not

| Situation | Use `log` |
| --- | --- |
| Reporting scout results, branch outcomes, fan-out summaries | Yes |
| Recording a cap/clamp/skip (slice, top-N, sampling, concurrency limit) | Yes — always |
| Returning the workflow's result | No — use the `return` value, not `log` |
| Per-token / per-chunk noise | No — one line per meaningful event |

## Gotchas

- **Never cap coverage silently.** Any slice/top-N/sampling/no-retry or
  concurrency clamp must be `log()`-ed so the cap is inspectable later.
- Prefer one clear line per meaningful event over noisy per-token logging.
- `log` is observability only — it does not affect control flow or the
  return value.

## Example

```js
export default async function main() {
  const items = ["a", "b", "c"];
  const results = await agents(items, { concurrency: 4, settle: true });
  const failed = results.filter((r) => r == null).length;
  log(`fan-out: ${results.length - failed}/${results.length} ok, ${failed} failed`);
  return results;
}
```
