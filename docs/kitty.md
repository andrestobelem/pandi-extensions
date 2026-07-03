# Configuración de kitty (entorno de desarrollo)

Configuración del terminal [kitty](https://sw.kovidgoyal.net/kitty/) que usamos
para trabajar en este repo (correr Pi, Supacode, y los dynamic workflows).

- **Fecha de captura:** 2026-07-03
- **kitty:** 0.47.4
- **Archivos:** [`config/kitty/kitty.conf`](../config/kitty/kitty.conf) y
  [`config/kitty/current-theme.conf`](../config/kitty/current-theme.conf)

Se versiona **solo lo que está activo**. El `kitty.conf` real generado por kitty
trae ~3000 líneas de defaults comentados; acá guardamos únicamente los 18 ajustes
que cambiamos, para que sea legible y reproducible. Todo lo demás usa los defaults
de kitty.

## Requisitos

- **kitty** ≥ 0.47 (`brew install --cask kitty` en macOS).
- **FiraCode Nerd Font Mono** instalada (`brew install --cask font-fira-code-nerd-font`).
  Es una Nerd Font: incluye los glifos/íconos que usan los prompts y la TUI de Pi.

## Qué hace cada ajuste

| Ajuste | Valor | Motivo |
|---|---|---|
| `include current-theme.conf` | — | Carga el tema (Catppuccin-Latte). |
| `font_family` / `font_size` | FiraCode Nerd Font Mono / 14 | Ligaduras + glifos Nerd Font. |
| `scrollback_lines` | 10000 | Historial amplio para logs de workflows. |
| `copy_on_select` | yes | Copiar al seleccionar, sin atajo. |
| `enable_audio_bell` | no | Sin bip. |
| `window_padding_width` | 8 | Aire alrededor del contenido. |
| `hide_window_decorations` | titlebar-only | Oculta la barra de título, conserva bordes. |
| `tab_bar_edge` / `tab_bar_style` / `tab_powerline_style` | top / powerline / slanted | Pestañas powerline arriba. |
| `tab_bar_min_tabs` | 1 | Muestra la barra incluso con una sola pestaña. |
| `tab_title_template` | `"{index} {title}"` | Pestañas numeradas. |
| `active_tab_font_style` | bold | Resalta la pestaña activa. |
| `background_opacity` / `background_blur` | 0.88 / 5 | Fondo semitransparente con desenfoque. |
| `allow_remote_control` + `listen_on` | yes / `unix:/tmp/kitty` | Control remoto para Supacode y scripting (`kitty @ ...`). |

## Tema

`current-theme.conf` es **Catppuccin-Latte** (variante clara), tomado de
[catppuccin/kitty](https://github.com/catppuccin/kitty). En el setup real,
`~/.config/kitty/current-theme.conf` suele ser un symlink/copia que el theme
switcher de kitty reescribe al alternar claro/oscuro.

## Cómo aplicarlo

```bash
# Backup de lo que tengas
cp -a ~/.config/kitty ~/.config/kitty.bak 2>/dev/null || true

mkdir -p ~/.config/kitty
cp config/kitty/kitty.conf         ~/.config/kitty/kitty.conf
cp config/kitty/current-theme.conf ~/.config/kitty/current-theme.conf
```

Recargá la configuración con `ctrl+shift+F5` (o reiniciá kitty).

## Actualizar esta copia

Si cambiás algo en `~/.config/kitty/kitty.conf`, regenerá la versión activa y
verificá que coincida:

```bash
# Ver los ajustes activos en vivo
grep -vE '^\s*#' ~/.config/kitty/kitty.conf | grep -vE '^\s*$'

# Comparar con la copia del repo (vacío = idéntico)
diff <(grep -vE '^\s*#' config/kitty/kitty.conf         | grep -vE '^\s*$') \
     <(grep -vE '^\s*#' ~/.config/kitty/kitty.conf       | grep -vE '^\s*$')
```
