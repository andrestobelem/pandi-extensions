# cwd

`cwd` es una string global de solo lectura inyectada en cada script de workflow: el directorio de trabajo absoluto de la
corrida. Usala cuando necesites armar a mano un path absoluto o registrar dónde está operando la corrida. La mayoría de
las veces no la vas a necesitar, porque los helpers de archivos ya resuelven contra ella.

```js
log(`workflow cwd: ${cwd}`);
const files = await listFiles("."); // se resuelve relativo a cwd
```

**Runtime:** pi runtime (contexto de ejecución de solo lectura)

**Firma:** `cwd` (string) — el directorio de trabajo del workflow

**Devuelve:** el path absoluto del directorio de trabajo.

Los helpers de archivos
([`readFile`](readFile.md)/[`writeFile`](writeFile.md)/[`appendFile`](appendFile.md)/[`listFiles`](listFiles.md))
resuelven los paths relativos contra `cwd` y quedan confinados dentro de ese root: no pueden escapar, ni siquiera a
través de symlinks.

## Cuándo usarlo

- **Sí:** para razonar dónde caen las lecturas y escrituras del repo o del workspace, o para construir un path absoluto
  cuando un helper lo necesite.
- **No:** para output inspeccionable acotado a la corrida. Eso va bajo [`runDir`](runDir.md) mediante `writeArtifact`.

## Cosas a tener en cuenta

- Es de solo lectura: no podés reasignarla.
- Los helpers de archivos ya resuelven contra `cwd`, así que preferí paths relativos simples (`"."`, `"src/foo.ts"`) en
  vez de prefijar `${cwd}/...` a mano.

## Example

```js
export default async function main() {
  log(`scanning repo at ${cwd}`);
  const files = await listFiles(".");
  const manifestPath = `${cwd}/package.json`;
  const manifest = await readFile("package.json", "utf8");
  return await agent(`Revisá ${files.length} archivos bajo ${manifestPath}`);
}
```
