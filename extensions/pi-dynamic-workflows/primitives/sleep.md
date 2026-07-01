# sleep

**Runtime:** pi runtime

**Signature:** `sleep(ms) → Promise<void>`

Wait `ms` milliseconds. The delay is bound to the run's abort signal, so it is
cancelled if the run/branch is aborted (e.g. a `race()` loser).

**Returns:** nothing (resolves after the delay, or rejects on abort).

## When to use / not

- **Use** for a small, deliberate pause (gentle backoff between polling probes).
- **Not** for busy-polling work the harness already tracks, and not to "fix" race
  conditions — sequence with awaits instead.

## Gotchas

- Abortable: a cancelled branch stops sleeping promptly.
- A duration derived from `Date.now()` is nondeterministic — avoid using such
  values in prompts/cache keys.

## Example

```js
for (let i = 0; i < maxTries; i++) {
  const { stdout } = await bash("check-ready.sh");
  if (stdout.includes("ready")) break;
  await sleep(2000);
}
```
