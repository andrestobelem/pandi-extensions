# pandi-session

En 30 segundos: `pandi-session` registra heartbeats locales de las sesiones Pi TUI/RPC de este proyecto y ofrece un dashboard independiente para verlas. Sirve para encontrar sesiones vivas/stale, cambiar a otra sesión cuando el runtime lo soporte y limpiar registros stale sin depender del dashboard de workflows.

## Uso

```text
/session          # abre el dashboard interactivo si hay TUI
/sessions list    # imprime una lista textual (útil en print/headless)
/sessions cleanup # borra registros stale del proyecto
```

Los registros viven bajo `.pi/pandi-session/live/` cuando el proyecto está trusted. En contextos no trusted se guardan bajo el agent dir global, particionados por hash del `cwd`.
