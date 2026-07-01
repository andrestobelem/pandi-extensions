# compact

**Runtime:** shared (pi + Claude Code)

**Signature:** `compact(value, maxChars?) → string`

Bounded stringify for **prompt building**: turn a value (object/array/string)
into a compact string, truncated to `maxChars` (defaults to the runtime's max
tool-text budget) so aggregated results stay within budget when fed to a
synthesis prompt.

**Returns:** a bounded string.

## When to use / not

- **Use** when packing many branch results into a judge/synthesis prompt — cap
  the size so lost-in-the-middle and context blow-ups are avoided.
- **Not** for exact data round-trips (it truncates) — persist those with
  [`writeArtifact`](writeArtifact.md).

## Gotchas

- Truncates by design; pair with evidence contracts (most-important-first) so the
  cut tail isn't the critical part.
- On Claude Code, `compact()` ships beside the `fence(kind, data)` helper in every
  scaffold.

## Example

```js
const findings = (await agents(files, { concurrency: 8, settle: true })).filter(Boolean);
return await agent(
  `Synthesize these findings, most severe first:\n${compact(findings, 40000)}`,
  { model: "opus", effort: "high" },
);
```
