# @pandi-coding-agent/pandi-theme

Temas Panda Syntax para Pi 🐼 — el compañero visual del mascota Pandi
(`pi-pandi`). Un port a la TUI de Pi del clásico tema
[Panda Syntax](https://github.com/PandaTheme) de editores, en variantes
oscura y clara.

## Install

From this repository:

```bash
pi install ./extensions/pi-pandi-theme
pi install -l ./extensions/pi-pandi-theme
```

## Provides

- `panda-syntax-dark` — fondo `#292A2B`, acentos `#19F9D8` (verde panda),
  `#FF75B5` (rosa) y `#45A9F9` (azul).
- `panda-syntax-light` — la misma paleta adaptada a terminales claras.

No incluye extensiones de código: es un paquete solo de temas
(`pi.themes` en `package.json`).

## Usage

Seleccioná el tema vía `/settings`, o en `settings.json`:

```json
{
  "theme": "panda-syntax-light/panda-syntax-dark"
}
```

La forma `light/dark` deja que Pi elija la variante según el fondo
detectado de la terminal; también podés fijar una sola
(`"theme": "panda-syntax-dark"`).

## Notes

- Los dos JSON viven en `themes/` y declaran los 51 tokens de color
  requeridos por el schema de temas de Pi.
- Si el tema activo se edita en disco, Pi lo recarga en caliente.
