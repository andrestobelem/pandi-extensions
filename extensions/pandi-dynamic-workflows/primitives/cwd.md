# cwd

`cwd` is a read-only global string injected into every workflow script: the
absolute working directory of the run. Reach for it when you need to build a
path yourself or just want to log where the run is operating — most of the
time you won't need it, because the file helpers already resolve against it.

```js
log(`workflow cwd: ${cwd}`);
const files = await listFiles("."); // resolved relative to cwd
```

**Runtime:** pi runtime (read-only run context)

**Signature:** `cwd` (string) — the workflow's working directory

**Returns:** the absolute working-directory path.

File helpers ([`readFile`](readFile.md)/[`writeFile`](writeFile.md)/
[`appendFile`](appendFile.md)/[`listFiles`](listFiles.md)) resolve relative
paths against `cwd` and are confined to it — they cannot escape it, even via
symlinks.

## When to use / not

- **Use** to reason about where repo/workspace reads and writes land, or to
  build an absolute path when a helper needs one.
- **Not** for run-scoped inspectable output — that goes under
  [`runDir`](runDir.md) via `writeArtifact`.

## Gotchas

- Read-only — you cannot reassign it.
- The file helpers already resolve against `cwd`, so prefer plain relative
  paths (`"."`, `"src/foo.ts"`) over prefixing `${cwd}/...` by hand.

## Example

```js
export default async function main() {
  log(`scanning repo at ${cwd}`);
  const files = await listFiles(".");
  const manifestPath = `${cwd}/package.json`;
  const manifest = await readFile("package.json", "utf8");
  return await agent(`Revisá ${files.length} archivos bajo ${manifestPath}`);
}
```
