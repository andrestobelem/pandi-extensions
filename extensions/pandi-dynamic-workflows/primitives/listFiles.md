# listFiles

`listFiles` recorre un directorio de forma recursiva y devuelve cada path de archivo que encuentra. Usalo para construir
una work-list durable dentro de un workflow — el equivalente a un paso de "scout" inline, pero acotado y logueable —
antes de abrir fan-out con `agents()` o `pipeline()`.

```js
const files = await listFiles("src", { maxFiles: 5000 });
log(`work-list: ${files.length} files`);
```

**Runtime:** pi runtime

**Firma:** `listFiles(dir = ".", options?) → Promise<string[]>`

Lista de forma recursiva los archivos bajo `dir` (relativo a `cwd`). Omite `node_modules` y `.git`. `options.maxFiles`
acota el recorrido (por defecto `10000`).

**Devuelve:** un array de paths **relativos a `cwd`** (con forward slashes).

## Cuándo usarlo y cuándo no

- **Usalo** para descubrir una work-list sobre la que después vas a hacer fan-out (el paso de inline-scout hecho durable
  dentro de un workflow).
- **No lo uses** como crawler sin límite: respetá o bajá `maxFiles` y hacé `log()` si llegás al cap.

## Cosas a tener en cuenta

- Omite automáticamente `node_modules`/`.git`; otros directorios grandes o generados (por ejemplo `dist`, `.venv`) los
  filtrás vos.
- Si el recorrido se frena en `maxFiles`, la cobertura queda capada: registralo con `log()`; nunca apliques un cap en
  silencio.
- Los paths son relativos a `cwd`, no a `dir`: sumá `dir` de nuevo si lo necesitás para mostrarlo.

## Example

```js
const files = (await listFiles("src", { maxFiles: 5000 })).filter((f) => f.endsWith(".ts"));
log(`work-list: ${files.length} TS files`);
const findings = await agents(files, { concurrency: 8, settle: true });
```
