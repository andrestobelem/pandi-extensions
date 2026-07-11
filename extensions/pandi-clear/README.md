# @pandi-coding-agent/pandi-clear

Agrega a Pi el comando `/clear` al estilo Claude. Si por costumbre de Claude Code escribís `/clear`, esta extensión lo
hace funcionar: inicia una sesión nueva, igual que el `/new` nativo de Pi. Sin configuración ni flags: instalala y la
memoria muscular hace el resto.

## Uso

```text
/clear
```

Cualquier argumento se ignora; la sesión simplemente se reinicia. Si sale bien, no dice nada: sin confirmación, solo una
pizarra limpia.

## Instalación

Desde npm:

```bash
pi install npm:@pandi-coding-agent/pandi-clear
```

Desde este repositorio:

```bash
pi install ./extensions/pandi-clear          # global (tu usuario)
pi install -l ./extensions/pandi-clear       # local al proyecto
pi --no-extensions -e ./extensions/pandi-clear   # prueba puntual, sin cargar nada más
```

## Comandos

| Comando  | Qué hace                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------- |
| `/clear` | Inicia una sesión nueva y limpia la conversación. Llama a `ctx.newSession()` — la misma sesión nueva que `/new`. |

## Cómo funciona

- `/clear` convive con el `/new` nativo de Pi y nunca lo reemplaza: usá el verbo que prefieras.
- El éxito es estrictamente silencioso, tanto en la TUI como en `print`: no hay notificación de confirmación.
- Una sesión nueva cancelada (una extensión la vetó vía `session_before_switch`) también queda en silencio; el host ya
  resolvió esa interacción.
- Si `newSession` falla, el error se informa como notificación de error (TUI) o se imprime en stderr (`print`) en lugar
  de romper la ejecución.

## Relacionado

Para instalar el paquete completo de extensiones y skills, instalá la raíz del repositorio.
