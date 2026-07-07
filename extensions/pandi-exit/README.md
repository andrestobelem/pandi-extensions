# @pandi-coding-agent/pandi-exit

Agregá a Pi un comando `/exit` al estilo Claude: un alias liviano de `/quit` para cerrar la sesión de forma limpia. Úsalo cuando la memoria muscular de Claude Code te haga escribir `/exit` y Pi solo conozca `/quit`.

## Inicio rápido

```bash
pi install npm:@pandi-coding-agent/pandi-exit
```

Luego, en cualquier sesión:

```text
> /exit
```

Eso ejecuta el mismo cierre limpio que `/quit`. Los argumentos se ignoran.

## Otras formas de instalar

Desde este repositorio:

```bash
pi install ./extensions/pandi-exit          # global (tu usuario)
pi install -l ./extensions/pandi-exit       # local al proyecto
pi --no-extensions -e ./extensions/pandi-exit   # prueba puntual, sin cargar nada más
```

## Comandos

| Comando | Qué hace |
| --- | --- |
| `/exit` | Sale de Pi limpiamente vía `ctx.shutdown()` — el mismo cierre limpio que `/quit`. Los argumentos se ignoran. |

## Cómo funciona

- `/exit` replica Claude Code, donde `/exit` (y `/quit`) sale de la sesión. Convive con el `/quit` nativo de Pi y nunca lo reemplaza; usá el verbo que prefieras.
- El éxito es estrictamente silencioso, tanto en la TUI como en modo print: no hay notificación de confirmación.
- `ctx.shutdown()` delega en un handler de cierre provisto por el modo, que puede lanzar de forma síncrona. Esa llamada está protegida, así que un `ctx.shutdown()` que falla se informa como notificación de error (TUI) o se imprime en stderr (modo print) — `exit failed: ...` — en lugar de tumbar la extensión o filtrar un error genérico.

## Relacionado

Para instalar el paquete completo de extensiones y skills, instalá la raíz del repositorio.
