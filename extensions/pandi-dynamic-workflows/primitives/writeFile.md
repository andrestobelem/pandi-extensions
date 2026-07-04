# writeFile

Save a file into the workspace (`cwd`) from inside a workflow — for example, a
generated report or a file the workflow is meant to produce as its final
output. Parent directories are created automatically; paths cannot escape
`cwd`.

```js
const report = await agent("Write the audit report as Markdown", { effort: "high" });
const { path } = await writeFile("docs/audit.md", report);
log(`wrote ${path}`);
```

**Runtime:** pi runtime

**Signature:** `writeFile(path, data) → Promise<{ path }>`

**Returns:** `{ path }` — the absolute path written.

## When to use / not

- **Use** to emit a workflow's product into the repo/workspace (a report, a
  generated file) when it belongs in `cwd`.
- **Not** for run-scoped, inspectable intermediate outputs — use
  [`writeArtifact`](writeArtifact.md), which lives under `runDir` and shows in the
  dashboard.

## Gotchas

- Confined to `cwd`: a path that resolves outside it (via `..` or a symlink)
  throws `Path escapes workflow cwd`, it is not silently clamped.
- Parent directories are created for you — no need to `mkdir` first.
- Never run untrusted-data neutralization on content written **verbatim** — fence
  only the inputs, not the output.

## Example

```js
const findings = await agent("Summarize the audit findings", { effort: "high" });
const { path } = await writeFile("docs/audit-summary.md", findings);
log(`workflow product ready at ${path}`);
return { path };
```
