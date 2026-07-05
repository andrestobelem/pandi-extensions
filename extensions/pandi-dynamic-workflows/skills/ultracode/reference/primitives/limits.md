# limits

`limits` is the run's effective caps (concurrency, budgets, timeouts),
injected as a frozen, read-only global. It exists so a workflow can size its
own fan-out to what the run actually allows instead of guessing or hardcoding
numbers. Reach for it whenever you're about to spawn N subagents and need to
know how many can run at once.

```js
const want = files.length;
const conc = Math.min(want, limits.concurrency);
if (conc < want) log(`clamping concurrency ${want} → ${conc} (limits.concurrency)`);
const results = await agents(files, { concurrency: conc, settle: true });
```

**Runtime:** pi runtime (read-only run context)

**Signature:** `limits` (frozen object) — `{ concurrency, maxAgents, timeoutMs, agentTimeoutMs, syncTimeoutMs }`

- `concurrency`: max in-flight subagents.
- `maxAgents`: total agent budget for the run.
- `timeoutMs`: overall run timeout.
- `agentTimeoutMs`: per-agent call timeout.
- `syncTimeoutMs`: timeout for the synchronous top-level script execution.

## Returns

An object of caps (see above), frozen — reassigning or mutating fields is a
no-op or throws under strict mode.

## When to use / not

| Situation | Do this |
| --- | --- |
| Sizing fan-out to the run's budget | `Math.min(desired, limits.concurrency)` |
| Deciding how many branches to spawn | Check against `limits.maxAgents` |
| Calling `agents()`/`parallel()`/`pipeline()` | No manual clamp needed — they already clamp `concurrency` to `limits.concurrency` |
| Trying to raise the cap at runtime | Don't — `limits` is frozen; caps come from the tool call that started the run |

## Gotchas

- Read-only (frozen): clamping *total agent count* against `maxAgents` is
  still your job — nothing enforces it automatically.
- **Log any clamp** you apply so the cap is inspectable in run artifacts.

## Example

```js
export default async function main(ctx, input) {
  const files = input.files ?? [];
  const conc = Math.min(files.length, limits.concurrency);
  log(`fanning out over ${files.length} files at concurrency ${conc}`);
  const results = await agents(
    files.map((f) => `Revisá ${f} buscando bugs`),
    { concurrency: conc, settle: true },
  );
  return results;
}
```
