---
description: Ejecutá Ultracode mediante el runner externo, observable y read-only de Claude Code.
---

# Ultracode runner para Claude Code

Este comando es distinto de `/ultracode`: ese skill usa la herramienta `Workflow`
nativa. `/ultracode-run` ejecuta el runner externo `pandi-ultracode-claude`, que
guarda un journal y artifacts reanudables bajo `.claude/ultracode/runs/`.

Usá como tarea el texto posterior al comando. Si falta, pedí una tarea concreta.

## Preflight seguro

1. Confirmá que el proyecto tiene `pandi-ultracode-claude` en
   `node_modules/.bin/`. Si falta, explicá cómo instalarlo; nunca instales nada
   ni cambies configuración por tu cuenta.
2. Explicá que `claude --print` no muestra el diálogo de confianza del workspace.
   Pedí una confirmación explícita de la persona antes de continuar. Sin ella,
   detenete sin lanzar workers.
3. Con esa confirmación, corré el gateway con el binario local, JSON bien escapado
   y límites explícitos:

   ```bash
   ./node_modules/.bin/pandi-ultracode-claude run claude-ultracode \
     --input '<JSON con request y context>' \
     --concurrency 4 --max-agents 8 --trust-workspace
   ```

4. Leé `result.json` y `summary.md` desde el `runDir` informado. Si el Contract
   Gate queda bloqueado, mostrale solo las preguntas que requieren una decisión.
5. Reportá ruta elegida, evidencia, ramas fallidas o vacías y siguiente paso.
   No reemplaces la salida del runner con una síntesis sin evidencia.

## Límites de esta entrega

- Los workers usan `--permission-mode plan`, allowlist de lectura y `--safe-mode`.
  No habilites escritura, shell, plugins, MCP, acceso adicional ni flags peligrosos.
- No afirmes compatibilidad con opciones de Pi que el runner rechaza por no poder
  imponerlas por worker. Mostrá el error y proponé el ajuste mínimo.
- Siempre devolvé el `runDir`, qué verificaste y las incertidumbres. Una síntesis
  de agentes no equivale a una verificación.
