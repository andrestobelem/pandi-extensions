# json

`json` turns any value into a string you can safely paste into a prompt or
write to an artifact — long objects get cut off instead of blowing your
context budget. Reach for it whenever you're about to embed structured data
(state, results, config) as text.

```js
await writeArtifact("state.json", json(state));
```

**Runtime:** pi runtime

**Signature:** `json(value, maxChars?) → string`

## Concepts

`json(value, maxChars)` serializes `value` with `JSON.stringify` (2-space
indent, circular refs replaced with `"[Circular]"`) and truncates the result
to `maxChars` characters, defaulting to 24000 (the runtime's max tool-text
budget). Strings pass through unserialized. If the text exceeds the limit, it
is cut and a trailing `...[truncated N chars]` marker is appended.

**Returns:** a bounded string representation.

## When to use / not

- **Use** to serialize structured data for a prompt or an artifact without
  risking an unbounded dump.
- **Not** when you need the raw, exact serialization of untruncated data — write
  it to an artifact instead (see the example above, without wrapping in `json`).

## Gotchas

- The output is **truncated** — it is for display/prompt embedding, not for
  round-tripping exact data.
- Functionally the same bounded stringify as [`compact`](compact.md) (same
  implementation, same 24000-char default); use `compact` in prompt-building
  for intent clarity, `json` when the value is going into a `.json` artifact.

## Example

```js
export default async function main() {
  const results = await parallel(
    ["api", "db", "ui"].map((area) => () => agent(`review ${area}`)),
  );
  const summary = { reviewed: results.length, results };
  await writeArtifact("summary.json", json(summary));
  return summary;
}
```
