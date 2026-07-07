---
name: deep-research
description: Usar cuando la persona usuaria pida investigación profunda, investigación respaldada por fuentes, o invoque la intención legacy deep-research. Enrutar al patrón complex-research de Dynamic Workflows.
---

# Investigación profunda

Para esta solicitud, usá el patrón `complex-research` de Dynamic Workflows.

1. Tratá la solicitud de la persona usuaria como la `question` de `complex-research`.
2. Si necesitás el scaffold, inspeccioná primero el patrón con `dynamic_workflow action=scaffold name=complex-research`.
3. Si corresponde lanzar un workflow, ejecutá o redactá `complex-research` en vez de resolver `deep-research` como alias de patrón.
4. Mantené las ramas de investigación en modo solo lectura y exigí citas/evidencia en la síntesis.
