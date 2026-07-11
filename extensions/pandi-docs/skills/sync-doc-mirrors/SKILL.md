---
name: sync-doc-mirrors
description:
  Verificá y regenerá mirrors committeados Markdown ↔ HTML con el motor de `pandi-docs`. Usá después de editar un
  Markdown espejado, para comprobar si los mirrors están sincronizados o para configurar `mirrors.json` en un repo
  nuevo. También se invoca con `/sync-doc-mirrors`.
---

# sync-doc-mirrors

## En 30 segundos

Mantené pares `.md` ↔ `.html` committeados declarados en `mirrors.json`. En **pandi-extensions** usá el wrapper de
política; en otros repos, el motor `sync-doc-mirrors.mjs` con `--check` y sync.

```bash
npm run sync:docs:html:check   # pandi-extensions
```

Mantené en sync los docs markdown de un repo y sus mirrors HTML estilizados y committeados. El mecanismo es
`scripts/sync-doc-mirrors.mjs` dentro de la extensión `pandi-docs`: cada par de mirror es una entrada
`{source, out?, kicker?, tokens?, css?, artifact?}`, declarada en un `mirrors.json` committeado y, opcionalmente, en un
`mirrors.local.json` hermano gitignored para docs por desarrollador. El render usa el convertidor Pandi; si el repo
tiene su propia estética, apuntá `css` (stylesheet completa) o `tokens` (solo paleta) a un archivo propio.

## Ubicá el motor

- **En `pandi-extensions`:** no llames el motor directo para `docs/html/`. Usá el wrapper de política:
  `npm run sync:docs:html` o `npm run sync:docs:html:check`.
- **En un repo consumidor:** el motor viene con el paquete instalado
  (`node_modules/@pandi-coding-agent/pandi-docs/scripts/sync-doc-mirrors.mjs`) o con un checkout de este repo
  (`extensions/pandi-docs/scripts/sync-doc-mirrors.mjs`). Mejor cablearlo como script de npm (`docs:sync` /
  `docs:check`) para que CI y pre-commit llamen el mismo entry point.

## Pasos

1. Desde la raíz del repo, verificá drift:

   ```bash
   node <engine>/sync-doc-mirrors.mjs --config path/to/mirrors.json --check
   ```

   - Exit 0 (`mirrors en sync`) → reportalo y frená.
   - Exit 1 → lista cada mirror desactualizado (o un source error por `bad-href`); seguí.

2. Si reportó links `.html` cuyo gemelo `.md` está dentro del set, corregí primero el markdown fuente. Los docs dentro
   del set enlazan a `.md`; el mirror se encarga de reescribir `.md → .html`.

   **Cierre:** los links internos al set apuntan a sources `.md` existentes.

3. Regenerá. Escribe solo los mirrors cuyo contenido cambió de verdad:

   ```bash
   node <engine>/sync-doc-mirrors.mjs --config path/to/mirrors.json
   ```

   **Cierre:** el comando termina con exit 0 y sólo cambia mirrors declarados por sources modificados.

4. Verificá el resultado antes de commitear o redeployar:

   ```bash
   node <engine>/sync-doc-mirrors.mjs --config path/to/mirrors.json --check
   ```

   **Cierre:** exit 0, sin mirrors desactualizados ni errores `bad-href`.

5. Committeá cada `.md` y su `.html` regenerado **en el mismo commit** que la edición que causó el drift. Los pares de
   `mirrors.local.json` son gitignored: no hay nada para commitear ahí.

   **Cierre:** cada source y mirror versionados comparten el mismo change set; los pares locales quedan fuera.

6. Las líneas `↳ redeploy artifact <url>` aparecen solo bajo mirrors que realmente cambiaron y tienen una entrada
   `artifact`. Para cada una, redeployá el HTML regenerado a esa misma url, conservando el `favicon` del manifest, para
   que las tres capas (`md → html → artifact`) sigan alineadas.

   **Cierre:** cada URL indicada sirve el HTML regenerado con el favicon declarado, o no hubo recordatorios de redeploy.

## Par nuevo / repo nuevo

1. Agregá una entrada a `mirrors.json`: `source` (un `.md` relativo al repo) alcanza; `out` por default apunta al
   `.html` hermano. Sumá `kicker` para la etiqueta del header, `artifact {url, favicon}` si la página se publica como
   Claude artifact, y `tokens` o `css` si el doc necesita una estética no-Pandi.

   **Cierre:** `--check` termina con exit 0 para la entrada nueva.

2. Gatealo: agregá la invocación con `--check` al script de tests del repo, a CI o al hook de pre-commit para que el
   drift falle rápido.

   **Cierre:** el gate queda instalado y una ejecución termina con exit 0.

## Notas

- Las líneas `skip:` significan que el source md no existe en esta branch: está bien, no es un error.
- Nunca edites a mano un `.html` generado; corregí el markdown y resincronizá.
- Para conversiones one-off (sin manifest), usá `/docs <file.md>` o el tool `markdown_to_html`.
