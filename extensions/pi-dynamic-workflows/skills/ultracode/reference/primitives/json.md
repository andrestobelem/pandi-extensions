# json

**Runtime:** pi runtime

**Signature:** `json(value, maxChars?) → string`

Safe, **bounded** stringify. Serializes `value` to a string, truncating to
`maxChars` (defaults to the runtime's max tool-text budget) so a large object
can't blow the context.

**Returns:** a bounded string representation.

## When to use / not

- **Use** to serialize structured data for a prompt or an artifact without
  risking an unbounded dump.
- **Not** when you need the raw, exact serialization of untruncated data — write
  it to an artifact instead.

## Gotchas

- The output is **truncated** — it is for display/prompt embedding, not for
  round-tripping exact data.
- Functionally the same bounded stringify as [`compact`](compact.md); use
  `compact` in prompt-building for intent clarity.

## Example

```js
await writeArtifact("state.json", json(state));
```
