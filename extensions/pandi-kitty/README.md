# pandi-kitty

Extensión de Pi para controlar el terminal [kitty](https://sw.kovidgoyal.net/kitty/)
en ejecución vía su protocolo de control remoto (`kitty @ ...`).

## Requisitos

`allow_remote_control yes` en `kitty.conf` (o `kitty -o allow_remote_control=yes`), y
correr Pi desde una sesión de kitty en ejecución.

## Comando

```
/kitty tab                 nueva tab
/kitty window               nueva ventana (según el layout activo)
/kitty vsplit                nueva ventana en split vertical
/kitty hsplit                nueva ventana en split horizontal
/kitty os-window             nueva ventana de OS
/kitty layout <nombre>        cambia el layout activo (ej. splits, tall, fat, grid)
/kitty close [id]             cierra una ventana (la activa si se omite el id)
/kitty focus <id>             enfoca una ventana por id
```

## Tool

`kitty_remote` — acciones `launch`, `goto-layout`, `close-window`, `focus-window`.
Ver `index.ts` para el esquema de parámetros completo.

## Nota

`--location vsplit/hsplit` solo tiene efecto visible bajo el layout `splits`. Bajo
otros layouts (`tall`, `fat`, `grid`, ...) la ventana se abre igual, pero la
dirección del split la decide ese layout.
