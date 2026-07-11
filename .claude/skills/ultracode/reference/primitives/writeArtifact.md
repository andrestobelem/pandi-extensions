# writeArtifact

Guarda un archivo con nombre dentro de la carpeta de salida de la corrida (`runDir`), no en el chat log. Eso hace que
hallazgos, borradores e informes sigan siendo inspeccionables cuando termina la corrida y aparezcan en vivo en el
dashboard y en `/workflow view`.

```js
const findings = await agents(files, { concurrency: 8, settle: true });
await writeArtifact("findings.json", findings.filter(Boolean));
const summary = await agent(`Synthesize:\n${compact(findings)}`, { effort: "high" });
await writeArtifact("summary.md", summary);
```

**Runtime:** pi runtime

**Signature:** `writeArtifact(name, data) → Promise<{ path }>`

**Returns:** `{ path }` — la ruta absoluta del artifact.

## Concepto

Si `data` es un `string` o `Uint8Array`, se escribe tal cual. Cualquier otro valor (objetos, arrays, números) se
serializa a JSON automáticamente. Además, cada llamada emite un evento `artifact`, que es lo que hace que el archivo
aparezca en vivo en el dashboard.

## Cuándo usarlo

| Situación                                                                                           | Usá                                                                                 |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Output intermedio o final que querés auditar después de la corrida (hallazgos, síntesis, evidencia) | `writeArtifact`                                                                     |
| Un archivo que pertenece al repo o workspace                                                        | [`writeFile`](writeFile.md) (escribe en `cwd`, no en `runDir`)                      |
| Construir un artifact de forma incremental entre llamadas (por ejemplo, un log en vivo)             | [`appendArtifact`](appendArtifact.md) — `writeArtifact` sobrescribe en cada llamada |

## Cosas a tener en cuenta

- Vive bajo `runDir` (scope de corrida), no bajo `cwd`: no lo uses para escribir archivos del workspace.
- Sobrescribe en cada llamada; usá `appendArtifact` para escrituras incrementales y así evitar que agentes concurrentes
  corrompan un archivo compartido.
- Preferí artifacts antes que volcar resultados intermedios grandes en el chat/log.

## Example

```js
const files = await listFiles("src", { recursive: true });
const reviews = await agents(
  files.map((f) => `Revisá ${f} buscando bugs.`),
  { concurrency: 8, settle: true },
);
const { path } = await writeArtifact("review.json", reviews.filter(Boolean));
log(`Wrote review artifact to ${path}`);
```
