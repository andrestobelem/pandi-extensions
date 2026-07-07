# @pandi-coding-agent/pandi-btw

Haz una pregunta lateral rápida sobre la conversación actual sin tocar tu sesión: un comando `/btw` al estilo Claude para Pi. Responde con el contexto que el modelo ya tiene, sin acceso a tools, y la pregunta/respuesta nunca se agregan al historial.

Sirve para consultas como “¿qué decidimos?” o “¿qué archivo era ese?”; no para tareas que requieran nuevas lecturas de archivos, comandos o búsquedas web.

```bash
/btw qué decidimos sobre auth?
```

La respuesta aparece en un overlay descartable y desplazable en la TUI (o se imprime / muestra como notificación fuera de la TUI) y nunca se escribe de vuelta en la sesión.

## Instalación

Desde npm:

```bash
pi install npm:@pandi-coding-agent/pandi-btw
```

Desde este repositorio:

```bash
pi install ./extensions/pandi-btw          # global (tu usuario)
pi install -l ./extensions/pandi-btw       # local al proyecto
pi --no-extensions -e ./extensions/pandi-btw   # prueba puntual, sin cargar nada más
```

## Comandos

| Comando | Qué hace |
| --- | --- |
| `/btw <question>` | Hace una pregunta lateral sobre la conversación actual; la respuesta aparece en un overlay descartable y nunca se agrega al historial. |
| `/btw` | Sin pregunta, muestra una notificación de uso (se imprime en la consola solo en modo `--print` o cuando no hay UI). |

En la TUI, el overlay se desplaza con `↑/↓` `j/k` (línea) y `PgUp/PgDn` (página); cerralo con `q` o `Esc`. En modos no TUI (`--print`, RPC/JSON) la respuesta se imprime o se muestra como notificación.

## Cómo funciona

- El handler de `/btw` corre al enviar; el texto tipeado no se agrega a la sesión.
- Lee la rama actual (solo lectura) y arma una petición de una sola vez: la conversación existente más tu pregunta, con un system prompt conciso y **sin tools**.
- Llama una sola vez al modelo actual mediante `completeSimple()` y muestra la respuesta con `ctx.ui`; nunca realiza escrituras de sesión, así que la pregunta/respuesta queda fuera del historial.

## Limitaciones y notas de seguridad

- Toda la rama actual se envía como contexto; las sesiones muy largas dependen de la truncación del propio proveedor.
- Como la respuesta no se guarda, no se puede buscar en el historial de la sesión; es así por diseño.
- Se espera la respuesta completa antes de mostrarla (sin streaming en el overlay).

## Relacionado

Para instalar el paquete completo de extensiones y skills, instalá la raíz del repositorio.
