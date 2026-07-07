# @pandi-coding-agent/pandi-ask

Herramientas interactivas para que el modelo te pida una decisión sin caer en menús de texto plano. `ask_choice` abre un selector con flechas y Enter; `ask_confirm` abre un diálogo sí/no. Ambas envuelven los helpers de diálogo de pi (`ctx.ui.select` / `ctx.ui.confirm`) y funcionan tanto en TUI como en RPC.

## Inicio rápido

Instalá una vez:

```bash
pi install npm:@pandi-coding-agent/pandi-ask
```

Luego el modelo puede llamar a `ask_choice` en medio de la conversación. Elegís con `↑↓` + Enter y devuelve:

```json
{ "index": 1, "label": "Patch the bug" }
```

Si el modelo marca una respuesta recomendada, podés activar la autoelección:

```text
/ask recommended on          # siempre elige de inmediato la respuesta recomendada
/ask recommended-timeout on  # espera 60s y luego elige la respuesta recomendada
/ask status                  # muestra ambos toggles
```

## Herramientas

| Herramienta | Llamada | Devuelve |
| --- | --- | --- |
| `ask_choice` | `ask_choice(question, options, recommendedIndex?, recommendedLabel?)` — `options` es una lista no vacía de strings, en orden de visualización; `recommendedIndex` es 1-based y tiene prioridad sobre `recommendedLabel` | JSON `{"index", "label"}` para la opción elegida (`index` es 1-based); `{"cancelled": true}` con Esc; `{"index", "label", "recommended": true}` cuando un toggle recomendado elige por vos |
| `ask_confirm` | `ask_confirm(title, message?, recommended?)` — `message` es opcional; `recommended` es la respuesta booleana sugerida | JSON `{"confirmed": true \| false}` (también `false` en cancelación/timeout); `{"confirmed", "recommended": true}` cuando un toggle recomendado elige por vos |

## Comandos

| Comando | Qué hace |
| --- | --- |
| `/ask` o `/ask status` | Muestra los toggles actuales del modo recomendado. |
| `/ask recommended on\|off\|status` | Activa o desactiva el modo recomendado inmediato. Cuando está activo, una respuesta recomendada válida se devuelve sin abrir diálogo. |
| `/ask recommended-timeout on\|off\|status` | Activa o desactiva el modo recomendado diferido. Cuando está activo, una respuesta recomendada válida se usa después de 60 segundos sin elección del usuario. |

Si los dos toggles están activos, gana el modo recomendado inmediato. Si una llamada no tiene una respuesta recomendada válida, el comportamiento vuelve al diálogo interactivo normal.

## Otras opciones de instalación

Desde este repositorio:

```bash
pi install ./extensions/pandi-ask          # global (tu usuario)
pi install -l ./extensions/pandi-ask       # local al proyecto
pi --no-extensions -e ./extensions/pandi-ask   # prueba puntual, no carga nada más
```

## Limitaciones y notas de seguridad

- Cuando no hay UI de diálogo disponible (`ctx.hasUI` es false — por ejemplo en modo `print`/`json`), ninguna herramienta abre un diálogo y ambas devuelven un error en texto plano, así quien llama puede volver a preguntar por texto. Si el modo recomendado diferido está activo y hay una respuesta recomendada válida, se devuelve esa respuesta.
- `ask_choice` con una lista vacía de `options` también devuelve un error en texto plano en vez de abrir un diálogo.
- En el modo recomendado diferido, cancelar manualmente con Esc antes de los 60s sigue contando como cancelación para `ask_choice`; la opción recomendada solo se usa cuando el timeout cierra el diálogo.

## Relacionado

Para instalar el paquete completo de extensiones y skills, instalá la raíz del repositorio.
