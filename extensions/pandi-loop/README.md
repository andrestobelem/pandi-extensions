# @pandi-coding-agent/pandi-loop

Mantené una tarea corriendo vuelta tras vuelta sin re-promptearla a mano: `/loop` reinyecta la próxima iteración solo,
con una cadencia que el modelo elige o que tú fijás, hasta que ella (o vos) la dé por terminada. Servirá para trabajos
de varias pasadas: mirar un CI, iterar una corrección, seguir un proceso lento.

## En 30 segundos

```bash
pi install npm:@pandi-coding-agent/pandi-loop
```

```text
/loop "watch the CI run and tell me when it's green"
```

Esto inicia un loop **dynamic**: hace una pasada inmediata y después el modelo llama a la tool `loop_schedule` para
elegir el próximo wakeup (clamp a 60s-1h) — sin timer fijo y sin re-prompt manual. Podés frenarlo en cualquier momento
con `/loop stop`.

Desde este repo, en vez de npm: `pi install ./extensions/pandi-loop` (sumá `-l` para instalarlo local al proyecto, o
`pi --no-extensions -e ./extensions/pandi-loop` para probarlo solo).

## Elegir un modo

| Modo       | Empezá con                          | Cadencia                             | Cuándo usarlo                                                         |
| ---------- | ----------------------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| Dynamic    | `/loop <task>`                      | El modelo elige cada wakeup (60s-1h) | El ritmo es impredecible                                              |
| Fixed      | `/loop <task> <interval>`           | Vos fijás el período, p. ej. `10m`   | Sabés cada cuánto revisar                                             |
| Autonomous | `/loop auto <objective> [interval]` | Igual que arriba                     | Sin supervisión, en un proyecto trusted, después de confirmar una vez |

## Comandos

| Comando                                           | Qué hace                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| `/loop [--ultracode] <task>`                      | Inicia un loop dynamic; el modelo programa cada wakeup.                       |
| `/loop [--ultracode] <task> <interval>`           | Inicia un loop de intervalo fijo, por ejemplo `10m` o `1h`.                   |
| `/loop auto [--ultracode] <objective> [interval]` | Inicia un loop autónomo trusted después de que confirmes.                     |
| `/loop status\|pause\|resume\|stop [id]`          | Administra los loops en ejecución.                                            |
| `loop_schedule`                                   | Tool del modelo: programa el próximo wakeup en modo dynamic (no-op en fixed). |
| `loop_stop`                                       | Tool del modelo: detiene el loop dueño del turno actual.                      |

`--ultracode` (alias `--uc`) se parsea antes del token final de intervalo, así `--ultracode <task> 5m` conserva ambos;
solo empuja las iteraciones a apoyarse en dynamic workflows cuando eso justifica el costo, nunca por obligación.

## Cómo funciona y seguridad

- El estado persiste entre recargas; los wakeups se serializan para que haya un solo turno de piloto automático a la
  vez, incluso con varios loops activos.
- Los caps detienen un loop antes de que se rearme: máximo de iteraciones (25 por defecto), deadline de wall-clock (6h
  por defecto), tope de uso de contexto (90% por defecto) — y un watchdog de respaldo de 25h por encima de eso. El
  deadline usa `Date.now()`, no un reloj monotónico, así que un salto hacia atrás solo lo demora.
- Durante un turno de piloto automático, una compuerta de acciones destructivas confirma (con UI) o bloquea (sin UI)
  llamadas que matchean una allowlist conservadora: `rm` recursivo, force pushes, `git reset --hard`, drops SQL y
  escrituras fuera del proyecto.
- `/loop auto` necesita un proyecto trusted **y** una confirmación explícita; las sesiones sin UI lo rechazan, y un loop
  autónomo rehidratado se retira (no se reanuda) si el proyecto perdió trust.

## Relacionado

Para instalar el paquete completo de extensiones y skills, instalá la raíz del repositorio.
