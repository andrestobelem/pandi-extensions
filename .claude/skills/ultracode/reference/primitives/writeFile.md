# writeFile

Guarda un archivo en el workspace (`cwd`) desde dentro de un workflow. Sirve, por ejemplo, para escribir un reporte
generado o el archivo final que el workflow debe entregar. Los directorios padre se crean automáticamente y el path no
puede escapar de `cwd`.

```js
const report = await agent("Write the audit report as Markdown", { effort: "high" });
const { path } = await writeFile("docs/audit.md", report);
log(`wrote ${path}`);
```

**Runtime:** pi runtime

**Firma:** `writeFile(path, data) → Promise<{ path }>`

**Devuelve:** `{ path }` — el path absoluto escrito.

## Cuándo usarlo y cuándo no

- **Usalo** para emitir el producto del workflow dentro del repo/workspace (por ejemplo, un reporte o un archivo
  generado) cuando pertenece a `cwd`.
- **No lo uses** para salidas intermedias inspeccionables y acotadas a la run: usá [`writeArtifact`](writeArtifact.md),
  que vive bajo `runDir` y aparece en el dashboard.

## Cosas a tener en cuenta

- Está confinado a `cwd`: si un path resuelve fuera de ahí (vía `..` o un symlink), lanza `Path escapes workflow cwd`;
  no se recorta en silencio.
- Los directorios padre se crean por vos: no hace falta correr `mkdir` antes.
- Nunca apliques neutralización de datos no confiables sobre contenido escrito **verbatim**: encerrá solo los inputs, no
  el output.

## Example

```js
const findings = await agent("Summarize the audit findings", { effort: "high" });
const { path } = await writeFile("docs/audit-summary.md", findings);
log(`workflow product ready at ${path}`);
return { path };
```
