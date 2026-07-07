---
name: markdownlint-cli2
description: >-
  Usá markdownlint-cli2 en este repositorio para lint o fix de archivos
  Markdown con el mismo motor DavidAnson markdownlint que usa la extensión
  markdownlint de VS Code. Usar al crear, editar, revisar o validar Markdown.
---

# markdownlint-cli2

Usá este skill cuando una tarea cree, edite, revise o valide Markdown en este repositorio.

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

La configuración del repo vive en `.markdownlint-cli2.jsonc` y es, a propósito, una base amigable con el legado:

- lint sobre `**/*.md` por defecto;
- respeta `.gitignore`;
- ignora rutas generadas o efímeras como `.pi/**`, `.cache/**` y `node_modules/**`;
- ignora `docs/conversaciones/**` porque las transcripciones de conversaciones repiten headings intencionalmente;
- relaja reglas ruidosas de documentación histórica, pero mantiene habilitados los chequeos default de markdownlint en lo demás.

## Flujo de trabajo

1. Antes de editar, inspeccioná el archivo objetivo y el `git status` actual para no reescribir archivos sucios no relacionados.
2. Después de editar Markdown, corré un chequeo focalizado sobre los archivos que tocaste.
3. Si ese chequeo falla, corregí solo los problemas reportados en esos archivos y luego volvé a correrlo.
4. Corré `npm run lint:md` cuando la tarea pida validación de todo el repo o antes de afirmar que la configuración Markdown del repo funciona.
5. Reportá el comando exacto y su resultado.

## Cuidados

- No corras `npm run lint:md:fix` de forma amplia en un árbol sucio, salvo que la persona usuaria haya pedido limpieza Markdown repo-wide explícitamente.
- Si el lint reporta problemas preexistentes fuera de los archivos que tocaste, preservalos y mencionálos en vez de reescribirlos de manera oportunista.
- El formatter/linter es `markdownlint-cli2`, no el viejo `markdownlint-cli`; coincide con el ecosistema DavidAnson markdownlint que usa la extensión de VS Code.
