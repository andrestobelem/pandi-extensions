---
name: pandi-artifact-style
description:
  Aplicá el contrato visual Pandi al crear o revisar reportes, dashboards y otros artifacts HTML autocontenidos de
  presentación. Deferí conversiones desde Markdown a `md-to-html`.
---

# Estilo de artifacts HTML de Pandi

## En 30 segundos

Un HTML autocontenido con layout Claude-design y paleta Panda Syntax (claro + oscuro). Partí de
`reference/template.html`; sus custom properties dark/light deben ser semánticamente idénticas a
`reference/pandi-tokens.css`. Para `.md` → `.html`, deferí a `md-to-html`.

El resultado debe ser reconocible como artifact Pandi a simple vista: estructura y tipografía Claude-design, coloreadas
con la paleta Panda Syntax.

**Fuente de verdad para los colores:** `extensions/pandi-theme/themes/panda-syntax-dark.json` y
`panda-syntax-light.json`. No inventes tonos nuevos: mapeá cada color a uno de los tokens de abajo. Si el theme cambia,
los tokens de este skill deben actualizarse para reflejarlo.

## Principios de diseño (Claude design)

1. **Papel y tinta.** Una superficie de página calma (`--bg`) con cards apenas elevadas (`--paper`), separadas por
   bordes sutiles de 1px (`--line`). Sin sombras, sin gradientes. Esquinas redondeadas: 10–12px para cards, 999px para
   chips/pills.
2. **Jerarquía silenciosa.** Un solo color de acento guía la mirada (`--accent`, panda pink). Los headings son chicos y
   estructurales, no estridentes: un _kicker_ de 14px en mayúsculas con tracking sobre un `h1` de 34px; los headings de
   sección van en `--muted`, en 15px, mayúsculas y con tracking.
3. **Espacio en blanco generoso.** Contenedor con max-width ~980px, padding lateral de 24px, 40px arriba en el header y
   80px abajo. El cuerpo usa `18px/1.65` en la stack sans del sistema (preferencia del lector: las fuentes van ~20% más
   grandes que en la escala original de Claude-design; la caja del layout no escala); la medida de prosa es ≤ ~74ch.
4. **Monospace para identidad.** IDs, paths, modelos y código usan `ui-monospace, Menlo, monospace`; nunca la prosa.
5. **Evidencia antes que decoración.** El estado se muestra con pills/callouts teñidos (`ok`/`run`/`fail`), no con
   íconos ni emoji. El trabajo fallido o salteado siempre se ve (callouts `error`/`warn`), nunca se oculta.
6. **Autocontenido.** Un solo archivo, CSS inline, sin build step. CDNs permitidos (solo cuando de verdad hagan falta):
   mermaid, highlight.js, marked, los mismos que ya usa `.claude/scripts/lib/render.mjs`.

## Paleta — tokens semánticos

Dark es la base (coincide con el default del TUI); light se activa vía `prefers-color-scheme`. Bloque completo para
copiar y pegar: [`reference/pandi-tokens.css`](./reference/pandi-tokens.css).

| Token                                          | Rol                                    | Dark                              | Light                             | Fuente en el theme                                |
| ---------------------------------------------- | -------------------------------------- | --------------------------------- | --------------------------------- | ------------------------------------------------- |
| `--bg`                                         | fondo de página                        | `#242526`                         | `#ECECEC`                         | `export.pageBg`                                   |
| `--paper`                                      | cards, bloques                         | `#292A2B`                         | `#F2F1F1`                         | `export.cardBg`                                   |
| `--info-bg`                                    | superficie de callout informativo      | `#2E2A33`                         | `#EDE4F8`                         | `export.infoBg`                                   |
| `--raised`                                     | hover/selected, chips, fondo de código | `#31353A`                         | `#E6DBCB`                         | `seal` / `sel`                                    |
| `--ink`                                        | texto principal                        | `#E6E6E6`                         | `#222223`                         | `fg`                                              |
| `--ink2`                                       | texto secundario                       | `#BBBBBB`                         | `#676B79`                         | `contrast` / `comment`                            |
| `--muted`                                      | texto terciario, headings de sección   | `#757575`                         | `#8D8D8D`                         | `lightGray` / `dim`                               |
| `--line`                                       | bordes sutiles                         | `#3E4250`                         | `#C9C9C9`                         | `steel` / `borderLt`                              |
| `--line-strong`                                | `hr`, bordes enfatizados               | `#676B79`                         | `#676B79`                         | `midnight` / `comment`                            |
| `--accent`                                     | kicker, acento principal               | `#FF75B5`                         | `#FF0077`                         | `pink`                                            |
| `--link`                                       | links                                  | `#6FC1FF`                         | `#0091FF`                         | `lightBlue` / `blue`                              |
| `--info`                                       | títulos, estado en ejecución           | `#45A9F9`                         | `#0091FF`                         | `blue`                                            |
| `--success`                                    | estados ok                             | `#19F9D8`                         | `#12B69D`                         | `green` / `teal`                                  |
| `--warning`                                    | caps, clamps, trabajo parcial          | `#FFCC95`                         | `#FF8400`                         | `lightOrange` / `orange`                          |
| `--error`                                      | fallas, blockers                       | `#FF4B82`                         | `#FF4B82`                         | `lightRed` / `red`                                |
| `--code`                                       | código inline                          | `#19F9D8`                         | `#12B69D`                         | `mdCode`                                          |
| `--purple`                                     | tipos, extras                          | `#BCAAFE`                         | `#B084EB`                         | `lightPurple` / `purple`                          |
| `--success-bg` / `--error-bg` / `--warning-bg` | superficies teñidas de callouts        | `#1E2E2B` / `#2E1E24` / `#2E2A33` | `#DCEEEA` / `#F7DCE4` / `#EDE4F8` | `toolSuccessBg` / `toolErrorBg` / `export.infoBg` |

El syntax highlighting en bloques de código sigue el theme: keywords pink, functions blue, strings green, numbers
orange, types purple y comments en `--line-strong`.

## Recetas de componentes

Markup + CSS funcionales para todo esto: [`reference/template.html`](./reference/template.html) (abrilo en el navegador
para revisar ambas variantes). Resumen:

- **Header**: kicker (14px en mayúsculas, tracking `.12em`, `--accent`, weight 600) → `h1` de 34px → resumen de un
  párrafo en `--ink2` → fila de `chips` para metadata (fecha, run id, counts).
- **Chips**: texto de 14px, padding `4px 10px`, radius 999px, fondo `--raised`, borde `--line`.
- **Status pills** (`ok`/`run`/`fail`): 13px en bold, fondo teñido (`--success-bg`/`--info-bg`/`--error-bg`) con texto y
  borde del mismo color.
- **Cards**: `--paper` con borde `--line`, radius 12px; fila de cabecera clickable (caret + id monospace en `--info` +
  título + pill alineada a la derecha); cuerpo colapsable en `--ink2`, separado por un borde superior.
- **Callouts**: info/success/warn/error — superficie teñida, borde de color, texto principal con una palabra inicial en
  bold.
- **Tables**: full-width dentro de un marco redondeado `--paper`; fila de encabezado en mayúsculas, 14px y `--raised`;
  separadores de fila solo con `--line`.
- **Code**: `code` inline en `--code` sobre `--raised`; bloques dentro de un marco redondeado `--paper` a 16px/1.6.
- **Quotes**: borde izquierdo de 3px en `--accent`, texto en `--ink2`.

## Reglas para artifacts HTML

1. Partí de `reference/template.html`; mantené sus custom properties dark/light semánticamente idénticas a
   `reference/pandi-tokens.css`, salvo que hayan cambiado los JSONs del theme.
2. Un solo archivo autocontenido; todo el CSS/JS inline salvo los CDNs permitidos.
3. Soportá ambos schemes vía `prefers-color-scheme`; nunca entregues una versión solo dark.
4. Escapá el contenido no confiable interpolado en HTML (`<`, `>`, `&`), como hace `render.mjs` con su JSON blob.
5. Mostrá la falla parcial: el trabajo failed/skipped/clamped lleva un callout `warn` o `error` cerca del inicio, no una
   nota al pie.
6. Línea de footer en `--muted`, 15px: generator + atribución de paleta.
7. Los diagramas Mermaid también deben usar la paleta pandi: theme `base` de mermaid con `themeVariables` mapeadas desde
   los tokens (`background`/ `mainBkg`/`primaryColor` desde las superficies, texto desde las inks, `titleColor` desde el
   accent, líneas desde `--muted`). Implementación de referencia: `mermaidThemeVariables()` en
   `extensions/pandi-docs/scripts/markdown-to-html.mjs`; copiala en lugar de inventar un mapeo nuevo.

**Cierre:** antes de entregar, verificá las siete reglas aplicables en el artifact generado; si una no aplica, dejá
explícito el motivo.

## Markdown → HTML

Para transformar un documento Markdown en un artifact HTML, cargá `md-to-html`. Ese skill es dueño de los comandos,
opciones, salida y verificación de la conversión; este skill gobierna el contrato visual que la salida debe respetar.
