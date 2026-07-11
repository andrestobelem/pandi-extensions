# @pandi-coding-agent/pandi-docs

Convierte un archivo Markdown en un único artifact HTML con CSS y tokens embebidos, sin build step, con temas claro y
oscuro integrados vía el skill `pandi-artifact-style` (layout Claude-design, paleta Panda Syntax). Usalo cuando
necesites entregar un informe o reporte como un `.html` único, listo para abrir desde disco o enviar por mail. Si el
Markdown contiene Mermaid, el archivo carga el runtime desde un CDN: requiere red y el diagrama puede quedar limitado
por una CSP restrictiva o por el modo offline.

```bash
/docs README.md --kicker "Informe"
# → Se escribió README.html
```

## Instalación

Desde npm:

```bash
pi install npm:@pandi-coding-agent/pandi-docs
```

Desde este repositorio:

```bash
pi install ./extensions/pandi-docs            # global (tu usuario)
pi install -l ./extensions/pandi-docs         # local al proyecto
pi --no-extensions -e ./extensions/pandi-docs # prueba puntual, sin cargar nada más
```

## Referencia

| Superficie              | Firma                                                                                                                  | Notas                                                                                                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Comando `/docs`         | `/docs <in.md> [more.md…] [-o\|--out out.html] [--kicker "Text"] [--tokens tokens.css] [--css style.css] [-h\|--help]` | Por defecto la salida usa la misma ruta de entrada con `.md` reemplazado por `.html`; `-o`/`--out` solo es válido con una única entrada.                                                                           |
| Tool `markdown_to_html` | `path`, opcional `out`, `kicker`, `tokens`, `css`                                                                      | Contraparte invocable por el modelo de `/docs` (los agentes no pueden tipear comandos con slash).                                                                                                                  |
| CLI                     | `node extensions/pandi-docs/scripts/markdown-to-html.mjs in.md -o out.html --kicker "Informe"`                         | El mismo conversor, usable fuera de una sesión de pi.                                                                                                                                                              |
| Motor de mirrors        | `node extensions/pandi-docs/scripts/sync-doc-mirrors.mjs --config mirrors.json [--root dir] [--check]`                 | Mirrors md ↔ html guiados por manifiesto para cualquier repo: escribe solo si cambia, recuerda redeploy de artifacts y poda huérfanos. Guiado por el skill [sync-doc-mirrors](./skills/sync-doc-mirrors/SKILL.md). |

Las tres primeras superficies comparten una sola implementación (`scripts/markdown-to-html.mjs`); `/docs` y
`markdown_to_html` agregan resolución de rutas (`~`, cwd) y feedback de escritura. El motor de mirrors compone el mismo
conversor con un manifiesto de mirrors (`{source, out?, kicker?, tokens?, css?, artifact?}` en cada entrada).

**Look propio por proyecto:** `--tokens`/`tokens` reemplaza solo la paleta de colores (conserva el layout pandi);
`--css`/`css` reemplaza la hoja de estilos completa.

Los detalles sobre soporte de mermaid, alertas de GitHub → callouts etiquetados y reglas de título/kicker están en el
skill [pandi-artifact-style](./skills/pandi-artifact-style/SKILL.md).

## Detalles

El conversor lee los tokens pandi desde `skills/pandi-artifact-style/reference/pandi-tokens.css` en tiempo de ejecución
y los embebe en el archivo final, así que el paquete sigue siendo autocontenido respecto del CSS y los tokens incluso
instalado de forma standalone. En el repo, esa copia del skill vendoreado es un espejo GENERADO de
`.pi/skills/pandi-artifact-style/` (`npm run sync:skills:vendor`) — editá la fuente `.pi`, no la copia. Mermaid es la
excepción de runtime descrita arriba: su script se obtiene desde el CDN y no se embebe.

## Relacionado

Para obtener el bundle completo de extensiones y skills, instalá la raíz del repositorio en su lugar.
