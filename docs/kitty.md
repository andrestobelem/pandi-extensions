# Configuración de kitty (entorno de desarrollo)

Esta guía registra la configuración activa de [kitty](https://sw.kovidgoyal.net/kitty/)
que usamos para trabajar en este repo: correr Pi, Supacode y los dynamic workflows.

Se versiona **solo lo que está activo**. El `kitty.conf` real generado por kitty
trae ~3000 líneas de defaults comentados; acá guardamos únicamente los ajustes
que cambiamos, para que sea legible y reproducible. Todo lo demás usa los defaults
de kitty.

- **Fecha de captura:** 2026-07-03
- **kitty:** 0.47.4
- **Archivos:** [`config/kitty/kitty.conf`](../config/kitty/kitty.conf),
  [`config/kitty/current-theme.conf`](../config/kitty/current-theme.conf) y los
  temas automáticos día/noche `light-theme.auto.conf` / `dark-theme.auto.conf` /
  `no-preference-theme.auto.conf`

## En 30 segundos

Si querés reproducir este entorno, instalá los requisitos, copiá los archivos
versionados a `~/.config/kitty/` y recargá kitty. Eso te deja el mismo tema
(día/noche automático), fuente, scrollback, tabs, tamaño de ventana y control
remoto que usamos en desarrollo.

## Requisitos

- **kitty** ≥ 0.47 (`brew install --cask kitty` en macOS).
- **FiraCode Nerd Font Mono** instalada (`brew install --cask font-fira-code-nerd-font`).
  Es una Nerd Font: incluye los glifos/íconos que usan los prompts y la TUI de Pi.

## Cómo aplicarlo

```bash
# Backup de lo que tengas
cp -a ~/.config/kitty ~/.config/kitty.bak 2>/dev/null || true

mkdir -p ~/.config/kitty
cp config/kitty/kitty.conf \
   config/kitty/current-theme.conf \
   config/kitty/light-theme.auto.conf \
   config/kitty/dark-theme.auto.conf \
   config/kitty/no-preference-theme.auto.conf \
   ~/.config/kitty/
```

Recargá la configuración con `ctrl+shift+F5` (o reiniciá kitty) y listo 🐼.

## Qué hace cada ajuste

| Ajuste | Valor | Motivo |
|---|---|---|
| `include current-theme.conf` | — | Tema de fallback (Catppuccin-Latte) si no hay soporte auto. |
| `*-theme.auto.conf` | Latte / Mocha | Día/noche automático: kitty ≥ 0.38 sigue el modo claro/oscuro de macOS. |
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
| `remember_window_size` / `initial_window_width` / `initial_window_height` | no / 120c / 80c | Ventana inicial fija de 120 columnas × 80 líneas. |
| `background_opacity` / `background_blur` | 0.88 / 5 | Fondo semitransparente con desenfoque. |
| `allow_remote_control` + `listen_on` | yes / `unix:/tmp/kitty` | Control remoto para Supacode y scripting (`kitty @ ...`). |
| `map cmd+t` | `new_tab_with_cwd` | Las tabs nuevas heredan el cwd de la ventana actual. |

## Tema

Los temas vienen de [catppuccin/kitty](https://github.com/catppuccin/kitty):

- `light-theme.auto.conf` / `no-preference-theme.auto.conf` = **Catppuccin-Latte** (claro)
- `dark-theme.auto.conf` = **Catppuccin-Mocha** (oscuro)
- `current-theme.conf` = Latte, solo como fallback vía `include`

Con los archivos `*-theme.auto.conf` presentes, kitty ≥ 0.38 alterna solo
cuando macOS cambia entre modo claro y oscuro — no hace falta ningún script.

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
