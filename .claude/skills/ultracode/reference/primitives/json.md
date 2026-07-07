# json

`json` convierte cualquier valor en un string que podés pegar con seguridad en
un prompt o escribir en un artifact. Si el objeto es largo, lo recorta en vez
de gastar de más tu presupuesto de contexto. Usalo cuando vayas a incrustar
como texto datos estructurados (`state`, resultados, config).

```js
await writeArtifact("state.json", json(state));
```

**Runtime:** pi runtime

**Signature:** `json(value, maxChars?) → string`

## Conceptos

`json(value, maxChars)` serializa `value` con `JSON.stringify` (indentación de
2 espacios y referencias circulares reemplazadas por `"[Circular]"`) y luego
trunca el resultado a `maxChars` caracteres. Por defecto usa 24000, que es el
máximo presupuesto de texto de tools del runtime. Los strings pasan sin
serializar. Si el texto supera el límite, se recorta y se agrega al final la
marca `...[truncated N chars]`.

**Devuelve:** una representación en string acotada.

## Cuándo usarlo y cuándo no

- **Usalo** para serializar datos estructurados hacia un prompt o un artifact
  sin arriesgar un volcado sin límite.
- **No lo uses** cuando necesites la serialización exacta, cruda y sin truncar:
  en ese caso escribila en un artifact (como en el ejemplo de arriba, pero sin
  envolverla con `json`).

## Ojo con esto

- La salida queda **truncada**. Sirve para mostrar o incrustar en prompts, no
  para reconstruir datos exactos.
- A nivel funcional hace el mismo bounded stringify que
  [`compact`](compact.md): misma implementación y mismo valor por defecto de 24000
  caracteres. Usá `compact` al construir prompts por claridad de intención, y
  `json` cuando el valor vaya a un artifact `.json`.

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
