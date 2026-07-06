# pandi-session

## En 30 segundos

`pandi-session` agrega `/sessions`: un dashboard TUI propio para ver las sesiones Pi vivas de este proyecto, detectar registros stale y cambiar a otra sesión cuando Pi expone `ctx.switchSession`.

Es independiente del runtime de workflows. Por ahora existe como superficie separada; cualquier consolidación futura se decidirá con evidencia después.

## Uso

| Comando | Qué hace |
| --- | --- |
| `/sessions` | Abre el dashboard TUI si hay UI; en headless imprime la lista textual. |
| `/sessions list` | Imprime la lista textual de sesiones del proyecto. |
| `/sessions cleanup` | Limpia registros stale seguros; nunca toca la sesión actual ni sesiones live. |

## Teclas del dashboard

| Tecla | Acción |
| --- | --- |
| `↑` / `↓` o `k` / `j` | Cambia la selección. |
| `Enter` / `→` | Cambia a la sesión seleccionada si hay transcript y `ctx.switchSession`. |
| `C` | Limpia registros stale con confirmación cuando hay UI. |
| `q` / `Esc` | Cierra el dashboard. |

## Modelo de datos

La extensión escribe heartbeats propios en `.pi/pandi-session/live/` para proyectos trusted; fuera de un proyecto trusted usa el directorio global del agente, separado por hash de `cwd`.

Cada registro incluye `pid`, `mode`, `cwd`, timestamps, metadata de `sessionManager` y flags livianos (`trusted`, `idle`). Una sesión se considera live cuando el PID existe y el heartbeat sigue fresco.

## Instalación standalone

```bash
pi install ./extensions/pandi-session
```

El paquete publica sus archivos TypeScript de primer nivel y no depende de otros paquetes de este monorepo en runtime.

> Nota: Pi ya tiene un comando interactivo built-in llamado `/session`; por eso esta extensión usa el plural `/sessions` para no pisarlo.
