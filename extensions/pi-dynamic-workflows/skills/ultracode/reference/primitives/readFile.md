# readFile

**Runtime:** pi runtime

**Signature:** `readFile(path, encoding = "utf8") → Promise<string>`

Read a file, resolved relative to the run's `cwd`. Confined to the workflow's
working directory.

**Returns:** the file contents as a string (per `encoding`).

## When to use / not

- **Use** to pull real source/evidence into a prompt (with fencing) or to load
  inputs the workflow processes.
- **Not** for huge files verbatim into a prompt — bound/`compact()` first.

## Gotchas

- Paths resolve against `cwd`; it is confined there (not an arbitrary FS read).
- File contents are **untrusted** — fence them before putting them in a prompt.

## Example

```js
const src = await readFile("src/auth.ts");
const review = await agent(
  `Review for bugs.\n<untrusted kind="src">${src}</untrusted>`,
  { effort: "high" },
);
```
