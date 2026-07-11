# readFile

Lee un archivo del disco y lo devuelve como string. Usalo cuando un paso del workflow necesite contenido real de un
archivo que todavía no está en `args`, para pasarlo a un prompt o procesarlo.

```js
const src = await readFile("src/auth.ts");
const review = await agent(`Revisá buscando bugs.\n<untrusted kind="src">${src}</untrusted>`, { effort: "high" });
```

**Runtime:** pi runtime

**Firma:** `readFile(path, encoding = "utf8") → Promise<string>`

**Devuelve:** el contenido del archivo como string, según `encoding`.

## Cuándo usarlo

- **Sí**: para traer código fuente o evidencia real a un prompt (con fencing) o para cargar entradas que el workflow va
  a procesar.
- **No**: para meter archivos enormes verbatim en un prompt; primero acotalos o usá `compact()`.

## Ojo

- Las rutas relativas se resuelven contra el `cwd` de la corrida. Las rutas absolutas se usan tal cual, pero igual deben
  resolver dentro de `cwd`. En ambos casos, un intento de escape (por ejemplo `../../etc/passwd`) hace `throw` en vez de
  leer fuera del sandbox.
- El contenido del archivo es **untrusted**: cercalo con fencing, como en el ejemplo anterior, antes de ponerlo en un
  prompt.

## Example

```js
const input = typeof args === "string" ? JSON.parse(args) : (args ?? {});
const diff = await readFile(input.diffPath ?? "CHANGES.diff");
const review = await agent(`Revisá este diff buscando regresiones.\n<untrusted kind="diff">${diff}</untrusted>`, {
  effort: "high",
});
await writeArtifact("review.md", review);
return { reviewed: true };
```
