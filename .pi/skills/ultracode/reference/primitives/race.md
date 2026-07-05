# race

`race` runs several branches at once and takes whichever one is "good enough"
first, then cancels the rest. Reach for it when you have redundant attempts at
the same goal (multiple endpoints, multiple retries) and only care about the
fastest acceptable answer — not the best one.

```js
const { winner, index, status } = await race(
  endpoints.map((url) => (signal) => agent(`Answer via ${url}: ${q}`, { signal })),
);
if (status === "won") log(`endpoint ${index} answered first`);
```

**Runtime:** pi runtime (not on the Claude Code Workflow tool)

**Signature:** `race(thunks, { accept? }) → Promise<{ winner, index, status, errors? }>`

Each `thunk` is `(signal) => Promise`; pass that `signal` into `agent()`/`ask()`
so losers are actually aborted (a real SIGTERM once one branch wins). `accept`
decides what counts as a win — default `(value) => value != null`, so a
resolved `null` is treated as a decline, not a win.

**Returns:**

- `status: "won"` → `winner` is the accepted value, `index` its position.
- `status: "empty"` → no branch was accepted; `winner` is `null`, `index` is
  `-1`.
- `errors?: [{ index, error }]` → present when one or more branches REJECTED
  (threw), so a genuine thunk bug is debuggable instead of looking like a
  clean all-decline. A plain decline (resolved `null`) adds no error entry.

## When to use / not

| Situation | Use |
| --- | --- |
| Hedge a flaky or slow call with redundant attempts | `race` — optimizes latency |
| Elegí la mejor respuesta por *calidad*, no por velocidad | `tournament` / `judge-escalate` — a judge must see every candidate |
| Just run N things and keep all results | `agents` / `parallel` |

## Gotchas

- Thunks MUST be functions taking `signal`; a non-empty array is required —
  `race([])` or non-function entries throw synchronously.
- Thread the `signal` through to `agent()`/`ask()`/`bash()`; if you don't,
  losers keep running after the race is decided.
- `errors` is additive: even with rejections, `winner`/`index`/`status` keep
  their normal meaning — check `status`, not `errors`, to know if you have a
  winner.

## Example

```js
export default async function main(ctx, input) {
  const endpoints = input.endpoints ?? [];
  const { winner, index, status, errors } = await race(
    endpoints.map((url) => (signal) => agent(`Fetch a status summary from ${url}`, { signal })),
    { accept: (value) => typeof value === "string" && value.length > 0 },
  );
  if (status === "empty") throw new Error(`no endpoint answered: ${JSON.stringify(errors)}`);
  return { source: endpoints[index], summary: winner };
}
```
