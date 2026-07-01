# limits

**Runtime:** pi runtime (read-only run context)

**Signature:** `limits` (frozen object) — `{ concurrency, maxAgents, … }`

The run's effective caps, injected as a flat global (a top-level script reaches
them without a `ctx` object). Frozen/read-only.

**Returns:** an object of caps, including `concurrency` (max in-flight subagents)
and `maxAgents` (total agent budget).

## When to use / not

- **Use** to size and clamp your fan-out to the run's actual budget
  (`Math.min(desired, limits.concurrency)`).
- **Not** to exceed them — `agents()` already clamps `concurrency` to
  `limits.concurrency`; respect `maxAgents` when deciding how many branches to
  spawn.

## Gotchas

- Read-only (frozen). Clamping is your job for total agent count; **`log()` any
  clamp** so the cap is inspectable.

## Example

```js
const want = files.length;
const conc = Math.min(want, limits.concurrency);
if (conc < want) log(`clamping concurrency ${want} → ${conc} (limits.concurrency)`);
const results = await agents(files, { concurrency: conc, settle: true });
```
