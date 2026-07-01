# race

**Runtime:** pi runtime (not on the Claude Code Workflow tool)

**Signature:** `race(thunks, { accept? }) → Promise<{ winner, index, status }>`

Fan out N branches and, the moment one produces an **accepted** value, **cancel
the in-flight losers** (a real SIGTERM via each thunk's `AbortSignal`). Each
`thunk` is `(signal) => Promise` — pass the `signal` into `agent()`/`ask()` so
losers are actually aborted. `accept` decides what counts as a win (default:
`(value) => value != null`).

**Returns:** `{ winner, index, status }`:

- `status: "won"` → `winner` is the accepted value, `index` its position.
- `status: "empty"` → no branch was accepted; `winner` is `null`, `index` is
  `-1`.

## When to use / not

- **Use** for first-good-answer-wins / hedging a flaky or latency-sensitive call
  (redundant attempts, fastest acceptable result).
- **Not** for picking the *best by quality* — that's a judge (`tournament`,
  `judge-escalate`), which must see all candidates. `race` optimizes latency, not
  merit.

## Gotchas

- Thunks MUST be functions taking `signal`; a non-empty array is required (throws
  otherwise).
- Thread the `signal` through so losers cancel; otherwise they keep running.

## Example

```js
const { winner, index, status } = await race(
  endpoints.map((url) => (signal) => agent(`Answer via ${url}: ${q}`, { signal })),
);
if (status === "won") log(`endpoint ${index} answered first`);
```
