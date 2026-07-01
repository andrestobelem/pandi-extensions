# writeFile

**Runtime:** pi runtime

**Signature:** `writeFile(path, data) → Promise<{ path }>`

Write a file relative to the run's `cwd`, creating parent directories as needed.

**Returns:** `{ path }` — the absolute path written.

## When to use / not

- **Use** to emit a workflow's product into the repo/workspace (a report, a
  generated file) when it belongs in `cwd`.
- **Not** for run-scoped, inspectable intermediate outputs — use
  [`writeArtifact`](writeArtifact.md), which lives under `runDir` and shows in the
  dashboard.

## Gotchas

- Confined to `cwd`; parent dirs are created automatically.
- Never run untrusted-data neutralization on content written **verbatim** — fence
  only the inputs, not the output.

## Example

```js
const report = await agent("Write the audit report as Markdown", { effort: "high" });
const { path } = await writeFile("docs/audit.md", report);
log(`wrote ${path}`);
```
