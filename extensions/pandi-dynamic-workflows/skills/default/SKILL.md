---
name: default
description: Enrutá manualmente la intención legacy `default` al patrón `fan-out-and-synthesize`.
disable-model-invocation: true
---

# Default de dynamic workflows

## En 30 segundos

Enrutá la tarea a `fan-out-and-synthesize`: fan-out paralelo de workers + síntesis final. `default` es sólo el alias
histórico del repo, no un patrón distinto.

1. Tratá la tarea de la persona usuaria como input de `fan-out-and-synthesize`.

   **Cierre:** el input conserva la tarea, alcance y evidencia que la síntesis debe entregar.

2. Si necesitás el scaffold, inspeccioná primero el patrón con
   `dynamic_workflow action=scaffold name=fan-out-and-synthesize`.

   **Cierre:** la entrada, salida y límites del patrón quedaron identificados antes de especializarlo.

3. Aplicá los gates de `ultracode` (`Contract Gate` → trivial → scout → motivo real para orquestar). Si corresponde usar
   un workflow, ejecutá o redactá `fan-out-and-synthesize` en vez de resolver `default` como alias de patrón.

   **Cierre:** la decisión de routing quedó explícita y, si se orquesta, el run o draft identifica
   `fan-out-and-synthesize` y la tarea original.

4. Conservá la cobertura y las fallas parciales visibles en la síntesis.

   **Cierre:** la síntesis declara ítems cubiertos, evidencia y cualquier rama fallida, vacía o no ejecutada.
