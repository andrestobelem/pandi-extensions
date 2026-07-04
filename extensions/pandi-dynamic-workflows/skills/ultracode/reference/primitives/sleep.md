# sleep

`sleep(ms)` pauses a workflow step for `ms` milliseconds — a plain,
cancellable delay. Reach for it when you need a deliberate pause, e.g.
gentle backoff between polling probes.

```js
for (let i = 0; i < maxTries; i++) {
  const { stdout } = await bash("check-ready.sh");
  if (stdout.includes("ready")) break;
  await sleep(2000);
}
```

**Runtime:** pi runtime

**Signature:** `sleep(ms) → Promise<void>`

**Returns:** nothing — the promise resolves after the delay, or rejects if
the run/branch is aborted while waiting.

## When to use / not

| Situation | Use `sleep`? |
| --- | --- |
| Backoff between polling probes | Yes |
| Waiting for a fixed, known interval | Yes |
| Busy-polling work the harness already tracks | No — let the harness track it |
| "Fixing" a race condition | No — sequence with `await` instead |

## Gotchas

- **Abortable.** The delay is bound to the run's abort signal, so it stops
  promptly if the run/branch is aborted (e.g. a `race()` loser) — it does not
  block cleanup.
- **Nondeterminism.** A duration derived from `Date.now()` is
  nondeterministic — avoid using such values in prompts/cache keys.

## Example

```js
export default async function main() {
  const maxTries = 5;
  for (let i = 0; i < maxTries; i++) {
    const { stdout } = await bash("curl -sf http://localhost:3000/health");
    if (stdout.includes("ok")) {
      return await agent("Service is healthy, summarize readiness.");
    }
    await sleep(2000);
  }
  return "service never became ready";
}
```
