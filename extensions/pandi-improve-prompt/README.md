# @pandi-coding-agent/pandi-improve-prompt

Reescribe un borrador de prompt torpe en uno más claro y accionable antes de enviarlo: un pequeño comando `/improve-prompt` para Pi.

```
/improve-prompt fix the bug in the parser
```

Una sola llamada al modelo (sin herramientas) reescribe el borrador: resuelve ambigüedades, agrega criterios de éxito concretos y verificables cuando aporta valor, y conserva tu idioma e intención. La reescritura se muestra para revisión — un overlay desplazable en la TUI, una notificación simple en RPC — y después te pregunta si querés **enviarla** como tu próximo mensaje. Si confirmás, se inyecta como un turno de usuario real (como el wake de aprobación de `/plan`); si rechazás, no se envía nada: la reescritura solo quedó en pantalla.

En `--print`/`json` (modo headless, de una sola pasada) no hay forma de pedir confirmación, así que la reescritura se imprime y no se envía nada — enviarla sin revisar sería un efecto secundario silencioso.

## Instalación

Desde npm:

```bash
pi install npm:@pandi-coding-agent/pandi-improve-prompt
```

Desde este repositorio:

```bash
pi install ./extensions/pandi-improve-prompt          # global (tu usuario)
pi install -l ./extensions/pandi-improve-prompt        # local al proyecto
pi --no-extensions -e ./extensions/pandi-improve-prompt   # prueba de una sola vez, no se carga nada más
```

## Comandos

| Comando | Qué hace |
| --- | --- |
| `/improve-prompt <draft>` | Reescribe el borrador con más claridad, lo muestra para revisión y luego pregunta si querés enviarlo como tu próximo mensaje. |
| `/improve-prompt` | Sin borrador, muestra una notificación de uso. |

## Cómo funciona

- Diseñado para funcionar de forma **autónoma**: a diferencia de `/btw`, el borrador se evalúa solo, sin apoyarse en la conversación actual, así que reescribe un draft flojo igual haya o no historial previo.
- La solicitud se arma con `completeSimple()` y lleva **cero herramientas**, así que el modelo solo puede responder en texto — la lógica pura de pedido/respuesta vive en `build-improve-context.ts`.
- El overlay está copiado de `pandi-btw` (la duplicación entre extensiones es intencional, para que cada una pueda publicarse de forma autónoma); se desplaza con `↑/↓` `j/k` y `PgUp/PgDn`, y se cierra con `q`/`Esc`.
- Enviar es la única escritura deliberada: `pi.sendUserMessage()` — un steer directo cuando está idle, un `followUp` en medio de una corriente — se dispara **solo** después de que confirmás con `ctx.ui.confirm`.
