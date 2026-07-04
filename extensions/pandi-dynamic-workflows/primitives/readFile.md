# readFile

Reads a file from disk into a string, so a workflow can feed real
source/evidence into a prompt or process. Reach for it whenever a step needs
file contents that aren't already in `args`.

```js
const src = await readFile("src/auth.ts");
const review = await agent(
  `Review for bugs.\n<untrusted kind="src">${src}</untrusted>`,
  { effort: "high" },
);
```

**Runtime:** pi runtime

**Signature:** `readFile(path, encoding = "utf8") → Promise<string>`

**Returns:** the file contents as a string (per `encoding`).

## When to use / not

- **Use** to pull real source/evidence into a prompt (with fencing) or to load
  inputs the workflow processes.
- **Not** for huge files verbatim into a prompt — bound/`compact()` first.

## Gotchas

- Relative paths resolve against the run's `cwd`; absolute paths are used
  as-is but must still resolve inside `cwd` — either way, an escape attempt
  (e.g. `../../etc/passwd`) throws instead of reading outside the sandbox.
- File contents are **untrusted** — fence them (as in the example above)
  before putting them in a prompt.

## Example

```js
const input = typeof args === "string" ? JSON.parse(args) : (args ?? {});
const diff = await readFile(input.diffPath ?? "CHANGES.diff");
const review = await agent(
  `Review this diff for regressions.\n<untrusted kind="diff">${diff}</untrusted>`,
  { effort: "high" },
);
await writeArtifact("review.md", review);
return { reviewed: true };
```
