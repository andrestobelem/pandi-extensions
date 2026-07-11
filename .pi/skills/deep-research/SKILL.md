---
name: deep-research
description: Activar cuando la persona usuaria pida investigación profunda, investigación respaldada por fuentes, o invoque la intención legacy deep-research. Enrutar al patrón complex-research de dynamic workflows.
---

# Investigación profunda

## En 30 segundos

Para `/deep-research` o pedidos de investigación profunda, usá el patrón `complex-research` de dynamic workflows.

1. Tratá la solicitud de la persona usuaria como la `question` de `complex-research`.

   **Cierre:** la pregunta conserva el alcance y la evidencia que la investigación debe producir.
2. Si necesitás el scaffold, inspeccioná primero el patrón con `dynamic_workflow action=scaffold name=complex-research`.

   **Cierre:** conocés el contrato de entrada, salida y límites del patrón antes de especializarlo.
3. Aplicá los gates de `ultracode`. Si indican que corresponde lanzar un workflow, ejecutá o redactá `complex-research` en vez de resolver `deep-research` como alias de patrón.

   **Cierre:** la decisión de routing quedó explícita y, si se orquesta, el run o draft identifica `complex-research` y la pregunta original.
4. Mantené las ramas de investigación en modo solo lectura y exigí citas/evidencia en la síntesis.

   **Cierre:** la síntesis distingue cobertura, citas/evidencia y cualquier rama fallida, vacía o no investigada.
