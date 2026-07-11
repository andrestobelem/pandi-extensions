# compact

`compact()` convierte cualquier valor (objeto, array o string) en un string acotado: serializa y trunca en una sola
llamada. Usalo cuando armes un prompt de síntesis o judge a partir de varios resultados de ramas: mantiene el prompt
combinado dentro del presupuesto en vez de pasarse del contexto del modelo.

```js
const findings = (await agents(files, { concurrency: 8, settle: true })).filter(Boolean);
return await agent(`Sintetizá estos hallazgos, de mayor severidad primero:\n${compact(findings, 40000)}`, {
  model: "opus",
  effort: "high",
});
```

**Runtime:** compartido (pi + Claude Code)

**Firma:** `compact(value, maxChars?) → string`

- `value` — string, objeto o array; lo que no sea string se serializa con `JSON.stringify` (indentación de 2 espacios,
  refs circulares reemplazadas por `"[Circular]"`).
- `maxChars` — por defecto usa el presupuesto máximo de texto de herramientas del runtime (24000).

## Qué devuelve

Devuelve el valor como string, truncado a `maxChars` con el sufijo `...[truncated N chars]` cuando se pasa.

## Cuándo usarlo

| Situación                                                            | Usá                                                                              |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Empaquetar muchos resultados de ramas en un prompt de judge/síntesis | `compact()`: limita el tamaño y evita lost-in-the-middle o desbordes de contexto |
| Conservar datos exactos para round-trip                              | [`writeArtifact`](writeArtifact.md): `compact()` trunca                          |

## Ojo

- El truncado corta la **cola**. Combinalo con un contrato de evidencia que ponga lo más importante primero; si no, la
  parte cortada puede ser la clave.
- En Claude Code, `compact()` viene junto al ayudante `fence(kind, data)` en cada plantilla: `fence` envuelve datos no
  confiables para el prompt y `compact` limita su tamaño; suelen usarse juntos.

## Example

```js
export default async function main() {
  const files = ["a.ts", "b.ts", "c.ts"];
  const results = await agents(
    files.map((f) => `Revisá ${f} buscando bugs`),
    { concurrency: 4, settle: true },
  );
  const findings = results.filter(Boolean);
  return await agent(`Sintetizá estos hallazgos, de mayor severidad primero:\n${compact(findings, 20000)}`, {
    model: "opus",
    effort: "high",
  });
}
```
