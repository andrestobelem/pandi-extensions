# log

**Runtime:** shared (pi + Claude Code)

**Signature:** `log(...args) → void`

Append a line to the run log. Non-string args are compacted. The log is the
run's inspectable timeline (visible in `/workflow view` and the dashboard).

**Returns:** nothing.

## When to use / not

- **Use** to make the run auditable: what was scouted, how many branches failed,
  and — critically — **every cap/clamp/skip** ("reviewed 40 of 213 files;
  skipped generated/").
- **Not** as a return channel — the workflow's return value is the result; `log`
  is for observability.

## Gotchas

- **Never cap coverage silently.** Any slice/top-N/sampling/no-retry or
  concurrency clamp must be `log()`-ed so the cap is inspectable.
- Prefer one clear line per meaningful event over noisy per-token logging.

## Example

```js
const results = await agents(items, { concurrency: 8, settle: true });
const failed = results.filter((r) => r == null).length;
log(`fan-out: ${results.length - failed}/${results.length} ok, ${failed} failed`);
```
