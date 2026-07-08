# runDir

`runDir` es un string global de solo lectura con la ruta absoluta del
directorio de la corrida actual: la carpeta donde viven los artifacts, los
eventos y el journal de esta corrida del workflow. Usalo cuando necesites registrar o
razonar sobre *dónde* quedó algo, no para escribir archivos directo.

```js
log(`artifacts de este run viven en ${runDir}`);
await writeArtifact("summary.md", summary); // resuelto bajo runDir; emite un evento
```

**Runtime:** pi runtime (contexto de corrida de solo lectura)

**Firma:** `runDir` (string) — directorio de esta corrida

**Devuelve:** la ruta absoluta del directorio de la corrida.

## Cuándo usarlo y cuándo no

- **Usalo** para saber dónde cae la salida asociada a la corrida. Preferí
  [`writeArtifact`](writeArtifact.md) y
  [`appendArtifact`](appendArtifact.md) antes que armar rutas a mano: resuelven
  nombres bajo `runDir` y emiten eventos.
- **No lo uses** para salida del repo o workspace: eso va bajo
  [`cwd`](cwd.md).

## Cosas a tener en cuenta

- Es de solo lectura. Si escribís archivos directo en `runDir` (salteando
  `writeArtifact`), no emitirán un evento `artifact`, así que no aparecerán en
  el dashboard.

## Ejemplo

```js
export default async function main() {
  log(`directorio del run: ${runDir}`);
  const findings = await agent("buscá TODOs en el repo");
  await writeArtifact("findings.md", findings);
  return `hallazgos escritos bajo ${runDir}/artifacts/findings.md`;
}
```
