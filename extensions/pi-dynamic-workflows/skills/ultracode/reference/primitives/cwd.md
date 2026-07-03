# cwd

**Runtime:** pi runtime (read-only run context)

**Signature:** `cwd` (string) — the workflow's working directory

The absolute working directory of the run. File helpers
([`readFile`](readFile.md)/[`writeFile`](writeFile.md)/[`appendFile`](appendFile.md)/[`listFiles`](listFiles.md))
resolve relative paths against it and are confined to it.

**Returns:** the absolute working-directory path.

## When to use / not

- **Use** to reason about where repo/workspace reads and writes land, or to build
  a path when a helper needs an absolute base.
- **Not** for run-scoped inspectable output — that goes under
  [`runDir`](runDir.md) via `writeArtifact`.

## Gotchas

- Read-only. The file helpers already resolve against `cwd`, so you rarely need it
  directly; prefer relative paths.

## Example

```js
log(`workflow cwd: ${cwd}`);
const files = await listFiles("."); // relative to cwd
```
