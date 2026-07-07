# appendFile

Agrega datos al final de un archivo relativo al `cwd` del run y crea los directorios padre en el camino si hacen falta. Usalo cuando un paso de un workflow necesita ir acumulando líneas en un archivo común con el tiempo — un log, un reporte que crece, un resumen en curso — sin recurrir a un agente completo ni a una llamada a `bash`.

```js
for (const line of summaryLines) {
  await appendFile("out/summary.txt", `${line}\n`);
}
```

**Runtime:** pi runtime

**Signature:** `appendFile(path, data) → Promise<{ path }>`

Agrega contenido a un archivo bajo el `cwd` del run.

**Returns:** `{ path }` — el path absoluto escrito.

## Cuándo usarlo

- **Sí**: para acumular líneas en un archivo dentro de `cwd` a lo largo de
  varios pasos.
- **No**: para un artifact scoped al run al que varios agentes concurrentes
  hacen append. En ese caso usá [`appendArtifact`](appendArtifact.md), que
  serializa por path para que los appends concurrentes no se intercalen.

## Detalles a tener en cuenta

- Está confinado a `cwd`; los directorios padre se crean automáticamente.
- No hay locking entre llamadas. Si hay appenders concurrentes, preferí
  `appendArtifact`.

## Example

```js
for (const line of summaryLines) {
  await appendFile("out/summary.txt", `${line}\n`);
}
log("summary written to out/summary.txt");
```
