# appendFile

**Runtime:** pi runtime

**Signature:** `appendFile(path, data) → Promise<{ path }>`

Append to a file relative to the run's `cwd`, creating parent directories as
needed.

**Returns:** `{ path }` — the absolute path written.

## When to use / not

- **Use** to accumulate lines into a `cwd` file across steps.
- **Not** for a run-scoped artifact that multiple concurrent agents append to —
  use [`appendArtifact`](appendArtifact.md), which serializes per-path so
  concurrent appends never interleave.

## Gotchas

- Confined to `cwd`; parent dirs are created automatically.
- No cross-call locking here — for concurrent appenders prefer `appendArtifact`.

## Example

```js
for (const line of summaryLines) {
  await appendFile("out/summary.txt", `${line}\n`);
}
```
