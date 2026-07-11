# @pandi-coding-agent/pandi-theme

Temas Panda Syntax para Pi 🐼, el compañero visual de la mascota Pandi (`pandi`): una versión TUI del tema clásico de
editor [Panda Syntax](https://github.com/PandaTheme), en variantes oscura y clara. Usalo cuando quieras que la terminal
de Pi adopte esa paleta en lugar del tema predeterminado.

## Inicio rápido

Instalalo y elegí el tema:

```bash
pi install npm:@pandi-coding-agent/pandi-theme
```

```json
{ "theme": "panda-syntax-light/panda-syntax-dark" }
```

Eso es todo: no hay comandos, herramientas ni configuración más allá de `settings.json`. Este paquete trae solo temas:
declara `pi.themes` en `package.json` y no incluye una extensión de código.

## Qué trae

- `panda-syntax-dark` — fondo `#292A2B` con acentos `#19F9D8` (panda green), `#FF75B5` (pink) y `#45A9F9` (blue).
- `panda-syntax-light` — la misma paleta adaptada a terminales claras.

## Instalación

| Origen                           | Comando                                          |
| -------------------------------- | ------------------------------------------------ |
| npm                              | `pi install npm:@pandi-coding-agent/pandi-theme` |
| repositorio, global (tu usuario) | `pi install ./extensions/pandi-theme`            |
| repositorio, local al proyecto   | `pi install -l ./extensions/pandi-theme`         |
| repositorio, prueba puntual      | `pi --no-extensions -e ./extensions/pandi-theme` |

La prueba puntual no carga nada más; sirve para previsualizar el tema sin tocar las extensiones instaladas.

## Uso

Elegí el tema desde `/settings`, o fijalo directo en `settings.json`:

```json
{
  "theme": "panda-syntax-light/panda-syntax-dark"
}
```

La forma `light/dark` le permite a Pi elegir la variante según el fondo que detecte en tu terminal. Si querés fijar una
sola variante, usá `"theme": "panda-syntax-dark"` (o `panda-syntax-light`).

## Detalles

- Los dos archivos JSON de tema viven en `themes/` y cada uno declara los 51 tokens de color que exige el esquema de
  temas de Pi.
- Si editás el archivo de tema activo en disco, Pi lo recarga en caliente.

## Relacionado

Para instalar el paquete completo de extensiones y skills, instalá la raíz del repositorio.
