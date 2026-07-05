# compact

Turns any value (object, array, string) into a bounded string — stringify plus
truncate, in one call. Use it whenever you build a synthesis/judge prompt from
several branch results: it keeps the combined prompt under budget instead of
blowing past the model's context.

```js
const findings = (await agents(files, { concurrency: 8, settle: true })).filter(Boolean);
return await agent(
  `Sintetizá estos hallazgos, de mayor severidad primero:\n${compact(findings, 40000)}`,
  { model: "opus", effort: "high" },
);
```

**Runtime:** shared (pi + Claude Code)

**Signature:** `compact(value, maxChars?) → string`

- `value` — string, object, or array; non-strings are `JSON.stringify`'d
  (2-space indent, circular refs replaced with `"[Circular]"`).
- `maxChars` — defaults to the runtime's max tool-text budget (24000).

**Returns:** the value as a string, truncated to `maxChars` with a
`...[truncated N chars]` suffix when it overflows.

## When to use / not

- **Use** when packing many branch results into a judge/synthesis prompt — cap
  the size so lost-in-the-middle and context blow-ups are avoided.
- **Not** for exact data round-trips (it truncates) — persist those with
  [`writeArtifact`](writeArtifact.md).

## Gotchas

- Truncation cuts the **tail**, so pair it with an evidence contract that puts
  the most-important-first — otherwise the cut part may be the critical one.
- On Claude Code, `compact()` ships beside the `fence(kind, data)` helper in
  every scaffold — `fence` wraps untrusted data for the prompt, `compact` caps
  its size; they're typically used together.

## Example

```js
export default async function main() {
  const files = ["a.ts", "b.ts", "c.ts"];
  const results = await agents(
    files.map((f) => `Revisá ${f} buscando bugs`),
    { concurrency: 4, settle: true },
  );
  const findings = results.filter(Boolean);
  return await agent(
    `Sintetizá estos hallazgos, de mayor severidad primero:\n${compact(findings, 20000)}`,
    { model: "opus", effort: "high" },
  );
}
```
