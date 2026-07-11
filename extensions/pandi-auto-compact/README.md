# @pandi-coding-agent/pandi-auto-compact

Las sesiones largas de Pi se quedan sin contexto, y un `/compact` manual puede
perder silenciosamente datos que todavía necesitabas. Esta extensión vigila el
uso de contexto y compacta sola cuando cruza un umbral (por defecto `35%` para
Claude/otros modelos y `50%` para Codex), con una barra en el footer para
anticiparlo, un hook de resumen rápido y acotado (Sonnet 5 por defecto,
`openai-codex/gpt-5.6-sol` en sesiones Codex) y una instantánea en disco para que
un resumen con pérdida nunca quede irrecuperable.

## Inicio rápido

```bash
pi install npm:@pandi-coding-agent/pandi-auto-compact
```

```text
/auto-compact                 # abre el menú interactivo (sesión con UI)
/auto-compact status          # muestra el umbral, la barra, el resumen, las instantáneas y el estado de clear-tools
/auto-compact 50              # sobrescribe el umbral predeterminado sensible al modelo
/auto-compact summary off     # vuelve al resumen nativo de compactación de Pi
/auto-compact clear-tools on  # también elide la salida vieja de tools en cada llamada al LLM
```

Otros modos de instalación: `pi install ./extensions/pandi-auto-compact` (global), agregar `-l`
(proyecto local) o `pi --no-extensions -e ./extensions/pandi-auto-compact` (prueba puntual).
La compactación corre sola después del turno de un agente cuando el uso supera el umbral.

## Comandos

| Comando | Qué hace |
| --- | --- |
| `/auto-compact` | Sin argumentos, en una sesión con UI abre un menú interactivo; si no, muestra el estado. |
| `/auto-compact status` | Muestra la configuración actual. |
| `/auto-compact on\|off` | Activa o desactiva la auto-compactación (`enable`/`disable` también funcionan). |
| `/auto-compact run` | Compacta el contexto ahora (`compact` también funciona). |
| `/auto-compact <1-99>` | Define el porcentaje de umbral de compactación. |
| `/auto-compact bar [on\|off]` | Muestra, oculta o alterna la barra de progreso del footer; por ejemplo `compact ▰▰▱▱▱▱▱▱ 9%/35%`. |
| `/auto-compact summary [on\|off]` | Alterna el hook de resumen rápido y acotado de compactación. |
| `/auto-compact snapshot [on\|off]` | Alterna las instantáneas recuperables antes de compactar. |
| `/auto-compact snapshots` | Lista las rutas de instantáneas recientes de la sesión actual. |
| `/auto-compact clear-tools [on\|off]` | Alterna la elisión de salidas viejas y grandes de tools por llamada al LLM. |

## Cómo funciona

**Resumen rápido** (activado por defecto): antes de que Pi escriba una entrada de compactación, la extensión intenta resumir con un prompt operativo acotado y un modelo elegido para la sesión actual: `anthropic/claude-sonnet-5` normalmente, `openai-codex/gpt-5.6-sol` en sesiones Codex. Se puede sobrescribir con `PI_AUTO_COMPACT_SUMMARY_MODEL=provider/model` o desactivar con `/auto-compact summary off`. Si falla la búsqueda del modelo, la autenticación o el resumen, Pi vuelve a su compactor nativo.

**Instantáneas** (a prueba de fallos, en `.gitignore`): en cualquier camino de compactación (manual, por umbral, recuperación de overflow), las entradas crudas se escriben en `<cwd>/.pi/compaction-snapshots/<sessionId>/<timestamp>-<reason>.json` y después se parchean con el resumen — un error de escritura nunca bloquea la compactación. Se separan de `.pi/memory/` (hechos curados, no transcripciones crudas).

**Limpieza de tool-result** (desactivada por defecto, efímera, no destructiva y más barata que compactar completo): antes de cada llamada al LLM, recorta el texto voluminoso de tool results viejos y ya consumidos, conservando un fragmento inicial y final. Solo toca el texto de `toolResult` (`toolCallId`/`toolName`/`isError`/imágenes se preservan); los resultados recientes y los de error nunca se limpian; al desactivarla, restaura de inmediato los originales completos, independientemente del umbral de compactación.

## Detalles

Valores iniciales, sobrescribibles mediante variables de entorno:

| Variable | Predeterminado | Significado |
| --- | --- | --- |
| `PI_AUTO_COMPACT_PERCENT` | sensible al modelo (`35` normalmente, `50` para Codex) | Porcentaje de umbral de compactación. |
| `PI_AUTO_COMPACT_BAR` | `on` | Visibilidad de la barra de progreso del footer. |
| `PI_AUTO_COMPACT_FAST_SUMMARY` | `on` | Usa el resumen personalizado rápido y acotado de compactación. |
| `PI_AUTO_COMPACT_SUMMARY_MODEL` | sensible al modelo (`anthropic/claude-sonnet-5`, Codex → `openai-codex/gpt-5.6-sol`) | Sobrescribe el modelo de resumen como `provider/model`. |
| `PI_AUTO_COMPACT_SUMMARY_MAX_TOKENS` | `4096` | Máximo de tokens de salida para la llamada de resumen. |
| `PI_AUTO_COMPACT_SUMMARY_MAX_INPUT_CHARS` | `80000` | Máximo de caracteres de entrada serializada enviados al prompt de resumen. |
| `PI_AUTO_COMPACT_SNAPSHOT` | `on` | Instantáneas recuperables antes de compactar. |
| `PI_AUTO_COMPACT_SNAPSHOT_KEEP` | `20` | Presupuesto de retención de instantáneas por sesión. |
| `PI_AUTO_COMPACT_CLEAR_TOOL_RESULTS` | `off` | Limpieza de tool-result. |
| `PI_AUTO_COMPACT_CLEAR_KEEP_RECENT` | `3` | Cantidad de tool results más recientes que se conservan intactos. |
| `PI_AUTO_COMPACT_CLEAR_MIN_CHARS` | `2000` | Solo elide texto de tool-result más largo que este valor. |

## Relacionado

Para instalar el paquete completo de extensiones y skills, instalá la raíz del repositorio.
