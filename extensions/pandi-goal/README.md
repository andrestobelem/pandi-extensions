# @pandi-coding-agent/pandi-goal

`/goal` convierte a Pi en un agente dirigido por objetivos: en vez de un solo
turno, sigue iterando hacia un objetivo durante varios turnos hasta que el
trabajo queda **verificado** de verdad, no solo autodeclarado como terminado.
Usalo cuando una tarea requiere varias iteraciones y querés un chequeo de
completitud incorporado más una verificación independiente antes de marcarla
como finalizada.

```text
/goal Agregá rate limiting al endpoint de login -- devuelve 429 después de 5 intentos fallidos en 60 s y un test unitario lo cubre
```

Pi itera, se autoevalúa contra los criterios con la herramienta
`goal_progress` y solo cierra el goal cuando un subagente aparte, de solo
lectura, lo confirma de forma independiente. Podés revisar el estado en
cualquier momento con `/goal status`.

## Qué obtenés

- Un loop `/goal` que vuelve a pedirle trabajo al modelo en cada iteración hasta que el objetivo se cumple, se bloquea o se detiene.
- Un chequeo de completitud: el primer `done` no detiene el goal; dispara una pasada de verificación y solo un `done` confirmado lo cierra.
- Un subagente verificador independiente y de solo lectura (tools: `read`, `grep`, `find`, `ls`; timeout de 120 s) que debe devolver PASS antes de aceptar el goal; después de 2 verificaciones independientes fallidas, el goal se detiene como `blocked`.
- Límites de seguridad: 30 iteraciones máximas y corte por presupuesto de contexto al 90% de uso por default.

## Instalación

Desde npm:

```bash
pi install npm:@pandi-coding-agent/pandi-goal
```

Desde este repositorio:

```bash
pi install ./extensions/pandi-goal          # global (tu usuario)
pi install -l ./extensions/pandi-goal       # local al proyecto
pi --no-extensions -e ./extensions/pandi-goal   # prueba puntual, sin cargar nada más
```

## Comandos

| Comando | Qué hace |
| --- | --- |
| `/goal [--ultracode] <objective> [-- <criteria>]` | Inicia un loop dirigido por objetivos; permite criterios de éxito opcionales después de `--`. |
| `/goal status [id]` | Inspecciona el estado del goal activo. |
| `/goal stop [id]` | Detiene un goal. |
| `goal_progress` | Herramienta del modelo: en cada iteración reporta `continue`, `done` o `blocked`. |

## `/goal` vs `/loop`

Ambos reinyectan un prompt sin scheduling nativo, pero responden preguntas
muy distintas:

| | `/goal` | `/loop` |
| --- | --- | --- |
| Guiado por | un OBJETIVO + criterios de éxito | una TAREA repetida con cadencia |
| El modelo reporta | `continue` / `done` / `blocked` | cuándo despertarse de nuevo (`delaySeconds`) |
| Termina cuando | los criterios se cumplen **y** se verifican de forma independiente | nunca por sí solo — lo frenás con `/loop stop` |

## Cómo funciona

- `--ultracode` (alias `--uc`) activa una **postura ultracode**: cada prompt de iteración le pide al modelo que conduzca el trabajo con dynamic workflows cuando eso justifique su costo (primero scout inline, después orquestación para exhaustividad, confianza o escala). Es solo inyección de prompt: no cambia el nivel de thinking ni fuerza la activación de `dynamic_workflow`. El flag puede aparecer en cualquier parte de los args y se elimina del objetivo.
- El estado del goal se persiste exclusivamente como entries `goal-state` en el JSONL de sesión. Sobrevive
  `reload`/`resume` mientras esa sesión exista y su JSONL sea válido; al rehidratarse, retoma sin doble disparo.
- Cuando un `done` verificado cerraría el goal, la extensión lanza el verificador independiente (proceso separado, ojos frescos). Un FAIL por debajo del tope reinyecta una iteración con la devolución del verificador; un FAIL al llegar al tope detiene el goal como `blocked` para que intervenga una persona.

## Límites y notas de seguridad

- Solo puede haber un goal activo a la vez; detené el actual antes de iniciar otro.
- `/goal` requiere una sesión TUI o RPC; no puede correr en otros modos.
- No se promete recovery ante un hard crash previo al flush, corrupción o truncado de la última entry, ni eliminación de
  la sesión. Los sidecars legados bajo `.pi/goals/` quedan inertes: `/goal` no los lee, reescribe ni borra.
- Un goal se detiene cuando llega a `maxIterations` (30) o al presupuesto de contexto (90% de uso); después de un corte por presupuesto podés hacer `/compact` y volver a empezar.

## Relacionado

Si querés el bundle completo de extensiones y skills, instalá la raíz del repositorio.
