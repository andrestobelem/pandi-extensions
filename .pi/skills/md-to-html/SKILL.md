---
name: md-to-html
description:
  Convertí Markdown en HTML autocontenido con estilo Pandi mediante `pandi-docs`. Usá cuando pidan una versión o mirror
  HTML de un documento, entregar un informe como un único archivo `.html`, o aplicar la paleta o la hoja de estilos de
  un proyecto. Invocá `/md-to-html path/to/doc.md`.
---

# md-to-html

Convierte un documento Markdown en una página HTML autocontenida y estilada: un solo archivo, sin paso de compilación,
con variantes clara y oscura incluidas.

## En 30 segundos

Dentro de Pi, preferí `/docs` o el tool `markdown_to_html`; fuera de Pi, corré el CLI del convertidor.

```bash
node <converter>/markdown-to-html.mjs <path/to/doc.md> --kicker "Proyecto · Área"
```

El archivo de salida queda junto al origen, salvo que pases `-o`.

## Dónde correrlo

- **Dentro de una sesión de pi:** usá el comando `/docs` o el tool `markdown_to_html` de la extensión `pandi-docs`.
  Ambos usan el mismo convertidor, con resolución de paths y feedback por encima. Preferilos si están disponibles.
- **En cualquier otro lado (`Claude Code`, CI, shell común):** corré el CLI. El convertidor viene con el paquete
  instalado (`node_modules/@pandi-coding-agent/pandi-docs/scripts/markdown-to-html.mjs`) o con un checkout de
  pandi-extensions (`extensions/pandi-docs/scripts/markdown-to-html.mjs`).

## Pasos

1. **Generar el HTML.**

   ```bash
   node <converter>/markdown-to-html.mjs <path/to/doc.md> --kicker "Proyecto · Área"
   ```

   Elegí el `--kicker` según el área del doc (`Policy`, `Research`, `Informe`, `Docs`); el valor por defecto es
   `Pandi artifact`.

   **Cierre:** el comando termina con exit 0 y existe el `.html` junto al origen o en la ruta indicada por `-o`.

2. **Ajustar el estilo si hace falta.**
   - `--tokens palette.css` — cambia solo la paleta de colores (custom properties) y conserva el layout Pandi.
   - `--css style.css` — reemplaza toda la hoja de estilos por la propia del proyecto; tiene prioridad sobre `--tokens`.

   **Cierre:** si aplicaste una opción, el comando ejecutado la incluye y la inspección de la salida confirma la paleta
   o stylesheet esperados.

3. **Revisar el resultado.** Abrí o leé la salida y verificá: título del masthead tomado del primer `# h1`, kicker, TOC
   (aparece con 4 o más secciones `##`), callouts etiquetados desde marcadores tipo `[!NOTE]`, bloques de código con
   resaltado y diagramas mermaid.

   **Cierre:** verificaste cada elemento aplicable; dejá explícito el motivo de cualquier elemento que no aplique al
   documento.

4. **Si el mirror debe quedar permanente,** agregá el doc a `mirrors.json` y derivá a `/sync-doc-mirrors`. Ese flujo se
   ocupa de `check`/`sync`, los recordatorios de redeploy y la poda de huérfanos.

   **Cierre:** el par quedó declarado en el manifest y el handoff al flujo de mirrors está explícito.

## Notas

- El Markdown es la fuente de verdad: nunca edites a mano el `.html` generado.
- El contrato completo de apariencia visual (tokens, layout, callouts y tematización de mermaid) vive en el skill
  `pandi-artifact-style`.
