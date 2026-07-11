---
name: ultracode
description: Ejecutá workflows observables y acotados mediante el runner de Pandi para Cursor.
disable-model-invocation: true
---

# Ultracode para Cursor

Usá esta skill solo por invocación explícita. Ultracode no reemplaza el juicio ni convierte una tarea chica en una
orquestación cara: primero definí el contrato, después elegí el camino más chico que pueda producir evidencia.

El runtime es `pandi-ultracode-cursor`, instalado en el proyecto. Sus workers usan Cursor CLI en modo de solo lectura y
guardan artifacts bajo `.cursor/ultracode/runs/`.

El runner es trusted-workspace only: antes de ejecutar pedí una confirmación explícita de que el workflow y el workspace
son confiables, y recién entonces pasá `--trust-workspace`. `node:vm` es un contexto de evaluación, no un sandbox de
seguridad.

## Protocolo

1. Ejecutá `contract-gate` con límites explícitos y revisá su `result.json`.
2. Si el veredicto es `BLOCKED`, pedí solo la decisión bloqueante.
3. Si el routing es trivial o single-agent, quedate en el chat.
4. Si amerita workflow, elegí un scaffold compatible y corrélo con un máximo de agentes y concurrencia visibles.
5. Informá `runDir`, evidencia, ramas fallidas y límites aplicados. Revisá los artifacts antes de declarar éxito.

No instales dependencias, no cambies permisos ni hagas escrituras/shell desde un workflow sin una instrucción humana
explícita y verificable.
