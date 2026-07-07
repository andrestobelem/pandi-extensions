---
name: pandi-artifact-style
description: >-
  Manual de estilo para artifacts producidos en o desde este repo: reportes y
  dashboards HTML autocontenidos, artifacts de runs de workflows, informes y
  documentación con estilo. Usar cuando generes un artifact HTML, reporte,
  dashboard o documento con calidad de presentación para que siga el lenguaje
  de layout Claude-design con la paleta Pandi (Panda Syntax) en variantes
  clara y oscura.
---

# Pandi artifact style

Una misma apariencia en todos lados: estructura y tipografía Claude-design,
coloreadas con la paleta Panda Syntax. Aplicalo a todo artifact de calidad de presentación
— reportes HTML, dashboards, salidas HTML de `writeArtifact()`, informes y
docs con estilo — para que una persona reconozca un artifact de pandi a simple
vista.

**Fuente de verdad para los colores:** `extensions/pandi-theme/themes/panda-syntax-dark.json`
y `panda-syntax-light.json`. No inventes tonos nuevos: mapeá cada color a uno
de los tokens de abajo. Si el theme cambia, los tokens de este skill deben
actualizarse para reflejarlo.

## Principios de diseño (Claude design)

1. **Papel y tinta.** Una superficie de página calma (`--bg`) con cards apenas
   elevadas (`--paper`), separadas por bordes sutiles de 1px (`--line`). Sin
   sombras, sin gradientes. Esquinas redondeadas: 10–12px para cards, 999px
   para chips/pills.
2. **Jerarquía silenciosa.** Un solo color de acento guía la mirada
   (`--accent`, panda pink). Los headings son chicos y estructurales, no
   estridentes: un *kicker* de 14px en mayúsculas con tracking sobre un `h1`
   de 34px; los headings de sección van en `--muted`, en 15px, mayúsculas y
   con tracking.
3. **Espacio en blanco generoso.** Contenedor con max-width ~980px, padding
   lateral de 24px, 40px arriba en el header y 80px abajo. El cuerpo usa
   `18px/1.65` en la stack sans del sistema (preferencia del lector: las
   fuentes van ~20% más grandes que en la escala original de Claude-design; la
   caja del layout no escala); la medida de prosa es ≤ ~74ch.
4. **Monospace para identidad.** IDs, paths, modelos y código usan
   `ui-monospace, Menlo, monospace`; nunca la prosa.
5. **Evidencia antes que decoración.** El estado se muestra con pills/callouts
   teñidos (`ok`/`run`/`fail`), no con íconos ni emoji. El trabajo fallido o
   salteado siempre se ve (callouts `error`/`warn`), nunca se oculta.
6. **Autocontenido.** Un solo archivo, CSS inline, sin build step. CDNs
   permitidos (solo cuando de verdad hagan falta): mermaid, highlight.js,
   marked, los mismos que ya usa `.claude/scripts/lib/render.mjs`.

## Paleta — tokens semánticos

Dark es la base (coincide con el default del TUI); light se activa vía
`prefers-color-scheme`. Bloque completo para copiar y pegar:
[`reference/pandi-tokens.css`](./reference/pandi-tokens.css).

| Token | Rol | Dark | Light | Fuente en el theme |
|---|---|---|---|---|
| `--bg` | fondo de página | `#242526` | `#ECECEC` | `export.pageBg` |
| `--paper` | cards, bloques | `#292A2B` | `#F2F1F1` | `export.cardBg` |
| `--info-bg` | superficie de callout informativo | `#2E2A33` | `#EDE4F8` | `export.infoBg` |
| `--raised` | hover/selected, chips, fondo de código | `#31353A` | `#E6DBCB` | `seal` / `sel` |
| `--ink` | texto principal | `#E6E6E6` | `#222223` | `fg` |
| `--ink2` | texto secundario | `#BBBBBB` | `#676B79` | `contrast` / `comment` |
| `--muted` | texto terciario, headings de sección | `#757575` | `#8D8D8D` | `lightGray` / `dim` |
| `--line` | bordes sutiles | `#3E4250` | `#C9C9C9` | `steel` / `borderLt` |
| `--line-strong` | `hr`, bordes enfatizados | `#676B79` | `#676B79` | `midnight` / `comment` |
| `--accent` | kicker, acento principal | `#FF75B5` | `#FF0077` | `pink` |
| `--link` | links | `#6FC1FF` | `#0091FF` | `lightBlue` / `blue` |
| `--info` | títulos, estado en ejecución | `#45A9F9` | `#0091FF` | `blue` |
| `--success` | estados ok | `#19F9D8` | `#12B69D` | `green` / `teal` |
| `--warning` | caps, clamps, trabajo parcial | `#FFCC95` | `#FF8400` | `lightOrange` / `orange` |
| `--error` | fallas, blockers | `#FF4B82` | `#FF4B82` | `lightRed` / `red` |
| `--code` | código inline | `#19F9D8` | `#12B69D` | `mdCode` |
| `--purple` | tipos, extras | `#BCAAFE` | `#B084EB` | `lightPurple` / `purple` |
| `--success-bg` / `--error-bg` / `--warning-bg` | superficies teñidas de callouts | `#1E2E2B` / `#2E1E24` / `#2E2A33` | `#DCEEEA` / `#F7DCE4` / `#EDE4F8` | `toolSuccessBg` / `toolErrorBg` / `export.infoBg` |

El syntax highlighting en bloques de código sigue el theme: keywords pink,
functions blue, strings green, numbers orange, types purple y comments en
`--line-strong`.

## Recetas de componentes

Markup + CSS funcionales para todo esto: [`reference/template.html`](./reference/template.html)
(abrilo en el navegador para revisar ambas variantes). Resumen:

- **Header**: kicker (14px en mayúsculas, tracking `.12em`, `--accent`, weight
  600) → `h1` de 34px → resumen de un párrafo en `--ink2` → fila de `chips`
  para metadata (fecha, run id, counts).
- **Chips**: texto de 14px, padding `4px 10px`, radius 999px, fondo
  `--raised`, borde `--line`.
- **Status pills** (`ok`/`run`/`fail`): 13px en bold, fondo teñido
  (`--success-bg`/`--info-bg`/`--error-bg`) con texto y borde del mismo color.
- **Cards**: `--paper` con borde `--line`, radius 12px; fila de cabecera
  clickable (caret + id monospace en `--info` + título + pill alineada a la
  derecha); cuerpo colapsable en `--ink2`, separado por un borde superior.
- **Callouts**: info/success/warn/error — superficie teñida, borde de color,
  texto principal con una palabra inicial en bold.
- **Tables**: full-width dentro de un marco redondeado `--paper`; fila de
  encabezado en mayúsculas, 14px y `--raised`; separadores de fila solo con
  `--line`.
- **Code**: `code` inline en `--code` sobre `--raised`; bloques dentro de un
  marco redondeado `--paper` a 16px/1.6.
- **Quotes**: borde izquierdo de 3px en `--accent`, texto en `--ink2`.

## Reglas para artifacts HTML

1. Partí de `reference/template.html`; mantené el bloque de tokens byte a byte
   idéntico a `reference/pandi-tokens.css`, salvo que hayan cambiado los JSONs
   del theme.
2. Un solo archivo autocontenido; todo el CSS/JS inline salvo los CDNs
   permitidos.
3. Soportá ambos schemes vía `prefers-color-scheme`; nunca entregues una
   versión solo dark.
4. Escapá el contenido no confiable interpolado en HTML (`<`, `>`, `&`), como
   hace `render.mjs` con su JSON blob.
5. Mostrá la falla parcial: el trabajo failed/skipped/clamped lleva un callout
   `warn` o `error` cerca del inicio, no una nota al pie.
6. Línea de footer en `--muted`, 15px: generator + atribución de paleta.
7. Los diagramas Mermaid también deben usar la paleta pandi: theme `base` de
   mermaid con `themeVariables` mapeadas desde los tokens (`background`/
   `mainBkg`/`primaryColor` desde las superficies, texto desde las inks,
   `titleColor` desde el accent, líneas desde `--muted`). Implementación de
   referencia: `mermaidThemeVariables()` en
   `extensions/pandi-docs/scripts/markdown-to-html.mjs`; copiala en lugar de
   inventar un mapeo nuevo.

## Convertir Markdown a HTML con estilo

Usá la extensión `pandi-docs` en vez de escribir el shell a mano: ella es dueña del
conversor (`extensions/pandi-docs/scripts/markdown-to-html.mjs`):

- **En una sesión de Pi**: el comando `/docs` (humano) o el tool
  `markdown_to_html` (modelo): `/docs in.md [more.md…] [-o out.html] [--kicker "Informe"]`.
- **Desde el shell**:

```bash
npm run md:html -- docs/research/example.md            # escribe example.html al lado
node extensions/pandi-docs/scripts/markdown-to-html.mjs in.md -o out.html --kicker "Informe"
```

- Acepta múltiples inputs `.md` (cada uno escribe un `.html` hermano); `-o`
  solo con uno.
- El primer `# h1` se vuelve el título/encabezado de la página; `--kicker` define
  el kicker (default `Pandi artifact`). El primer párrafo después del h1 se
  promociona al header como `lede` (20px, `--ink2`, alineado a la izquierda):
  es la apertura de 30 segundos del doc; los párrafos liderados por imágenes
  quedan en el body.
- Los GitHub alerts (`> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION]`) se vuelven
  callouts pandi con una etiqueta de tono en mayúsculas (`Note`/`Tip`/…).
- Las tables renderizan dentro de un contenedor `table-scroll`: las más anchas
  que la página hacen scroll horizontal en vez de desbordarse.
- Tipografía de prosa: `h2`/`h3`/`h4` son headings reales en tinta
  (24/19/17px) y el texto del cuerpo va justificado; el estilo de etiqueta en
  mayúsculas queda solo para dashboards (`h2.sec` en el template).
- Los fences de código `mermaid` renderizan diagramas con la paleta pandi (theme
  `base` de mermaid + `themeVariables` parseadas en runtime desde el archivo de
  tokens; dark/light sigue `prefers-color-scheme`). El script del CDN se
  inyecta solo cuando existe un diagrama; los documentos sin diagramas quedan
  sin JS.
- Los tokens se leen en runtime desde [`reference/pandi-tokens.css`](./reference/pandi-tokens.css)
  de este skill (la extensión lleva una copia vendorizada, byte a byte
  idéntica al skill); la salida es un único archivo autocontenido y sin JS.
- Tests de pinning: `extensions/pandi-docs/tests/integration/markdown-to-html.test.mjs` (`npm test`).

## Reglas para reportes Markdown (informes)

- Seguí las convenciones de `docs/`: incluí fecha, contexto, archivos
  afectados y próximos pasos; las notas de research van a `docs/research/` y
  las guías durables, a `docs/handbooks/`.
- Corré lint con el skill `markdownlint-cli2` antes de terminar.
- Markdown no lleva styling custom: la estructura hace el trabajo — un `h1`,
  secciones cortas, tables para comparaciones y fenced code para evidencia.
