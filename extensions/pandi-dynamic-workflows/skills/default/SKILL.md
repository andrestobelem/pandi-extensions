---
name: default
description: Usar cuando la persona usuaria pida el patrón legacy por defecto de Dynamic Workflows. Derivar al patrón `fan-out-and-synthesize`.
---

# Workflow dinámico por defecto

Para esta solicitud, usá el patrón `fan-out-and-synthesize` de Dynamic Workflows.

1. Tratá la tarea de la persona usuaria como input de `fan-out-and-synthesize`.
2. Si necesitás el scaffold, inspeccioná primero el patrón con `dynamic_workflow action=scaffold name=fan-out-and-synthesize`.
3. Si corresponde usar un workflow, ejecutá o redactá `fan-out-and-synthesize` en vez de resolver `default` como alias de patrón.
4. Conservá los gates normales del router: scout primero; orquestá solo por escala, confianza o exhaustividad.
