# runDir

`runDir` es un string global de solo lectura con la ruta absoluta del directorio de la corrida actual: la carpeta donde
viven los artifacts, los eventos y el journal de esta corrida del workflow. Usalo cuando necesites registrar o razonar
sobre _dónde_ quedó algo, no para escribir archivos directo.

```js
log(`artifacts for this run live in ${runDir}`);
await writeArtifact("summary.md", summary); // resolved under runDir, emits an event
```

**Runtime:** pi runtime (contexto de corrida de solo lectura)

**Signature:** `runDir` (string) — directorio de esta corrida

**Returns:** la ruta absoluta del directorio de la corrida.

## Cuándo usarlo y cuándo no

- **Usalo** para saber dónde cae la salida asociada a la corrida. Preferí [`writeArtifact`](writeArtifact.md) y
  [`appendArtifact`](appendArtifact.md) antes que armar rutas a mano: resuelven nombres bajo `runDir` y emiten eventos.
- **No lo uses** para salida del repo o workspace: eso va bajo [`cwd`](cwd.md).

## Cosas a tener en cuenta

- Es de solo lectura. Si escribís archivos directo en `runDir` (salteando `writeArtifact`), no emitirán un event
  `artifact`, así que no aparecerán en el dashboard.

## Example

```js
export default async function main() {
  log(`run directory: ${runDir}`);
  const findings = await agent("scan the repo for TODOs");
  await writeArtifact("findings.md", findings);
  return `wrote findings under ${runDir}/artifacts/findings.md`;
}
```
