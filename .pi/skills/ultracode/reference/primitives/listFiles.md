# listFiles

**Runtime:** pi runtime

**Signature:** `listFiles(dir = ".", options?) → Promise<string[]>`

Recursively list files under `dir` (relative to `cwd`). Skips `node_modules` and
`.git`. `options.maxFiles` bounds the walk (default `10000`).

**Returns:** an array of paths **relative to `cwd`** (forward slashes).

## When to use / not

- **Use** to discover a work-list to fan out over (the inline-scout step made
  durable inside a workflow).
- **Not** as an unbounded crawler — respect/lower `maxFiles` and `log()` if you
  hit the cap.

## Gotchas

- Auto-skips `node_modules`/`.git`; other large/generated dirs are up to you to
  filter.
- If the walk stops at `maxFiles`, coverage is capped — `log()` it (never cap
  silently).

## Example

```js
const files = (await listFiles("src", { maxFiles: 5000 })).filter((f) => f.endsWith(".ts"));
log(`work-list: ${files.length} TS files`);
const findings = await agents(files, { concurrency: 8, settle: true });
```
