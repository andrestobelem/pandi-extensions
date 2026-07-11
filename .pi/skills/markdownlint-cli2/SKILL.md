---
name: markdownlint-cli2
description:
  Validá o corregí Markdown con `markdownlint-cli2` al crear, editar o revisar archivos `.md` del repo.
---

# markdownlint-cli2

## En 30 segundos

`markdownlint-cli2` valida Markdown con el mismo motor que la extensión VS Code. Después de editar, corré un chequeo
focalizado; reservá `npm run lint:md` para validación repo-wide.

```bash
npx markdownlint-cli2 ":docs/example.md"
```

## Comandos

- Chequeo de todo el repo:

  ```bash
  npm run lint:md
  ```

- Auto-fix de todo el repo, solo cuando la persona usuaria pida cambios amplios sobre Markdown:

  ```bash
  npm run lint:md:fix
  ```

- Chequeo focalizado para algunos archivos:

  ```bash
  npx markdownlint-cli2 ":README.md" ":docs/example.md"
  ```

- Auto-fix focalizado para archivos que tocaste intencionalmente:

  ```bash
  npx markdownlint-cli2 --fix ":README.md" ":docs/example.md"
  ```

Usá el prefijo `:` para rutas literales, así los caracteres glob en nombres de archivo no se expanden.

## Configuración del repositorio

La configuración del repo vive en `.markdownlint-cli2.jsonc`:

- lint sobre `**/*.md` por defecto, incluidas las fuentes canónicas bajo `.pi/skills/`;
- respeta `.gitignore`, que excluye los artifacts y el estado efímero de Pi;
- ignora mirrors generados bajo `extensions/*/skills/**`, `.cache/**` y `node_modules/**`;
- ignora `docs/conversaciones/**` porque las transcripciones de conversaciones repiten headings intencionalmente;
- configura `MD012` con un máximo de una línea en blanco consecutiva para evitar espacio vertical sobrante;
- configura `MD013` en 120 caracteres, incluidos headings, y exceptúa tablas y bloques de código;
- relaja reglas ruidosas de documentación histórica, pero mantiene habilitados los chequeos default de markdownlint en
  lo demás.

## Flujo de trabajo

1. Antes de editar, inspeccioná el archivo objetivo y el `git status` actual para no reescribir archivos sucios no
   relacionados.
2. Después de editar Markdown, ajustá la prosa a 120 caracteres. Si un ejemplo indivisible no se puede envolver sin
   perder claridad, pasalo a un bloque de código.
3. Corré un chequeo focalizado sobre los archivos tocados. `MD013` detecta líneas largas, pero no las corrige con
   `--fix`.
4. Si ese chequeo falla, corregí solo los problemas reportados en esos archivos y luego volvé a correrlo.
5. Corré `npm run lint:md` cuando la tarea pida validación de todo el repo o antes de afirmar que la configuración
   Markdown del repo funciona.
6. Reportá el comando exacto y su resultado.

**Cierre:** inspeccionaste el alcance, el lint focalizado termina con exit 0, el gate repo-wide también pasa cuando
aplica y el reporte conserva el comando y resultado exactos.

## Cuidados

- No corras `npm run lint:md:fix` de forma amplia en un árbol sucio, salvo que la persona usuaria haya pedido limpieza
  Markdown repo-wide explícitamente.
- Si el lint reporta problemas preexistentes fuera de los archivos que tocaste, preservalos y mencionálos en vez de
  reescribirlos de manera oportunista.
- El formatter/linter es `markdownlint-cli2`, no el viejo `markdownlint-cli`; coincide con el ecosistema DavidAnson
  markdownlint que usa la extensión de VS Code.
