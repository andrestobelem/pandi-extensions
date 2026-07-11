---
name: ultracode
description: Conducí una tarea amplia con el runner de Ultracode para Cursor.
---

# Ultracode para Cursor

La persona invocó este comando explícitamente porque quiere una orquestación verificable. Usá como tarea el pedido
actual del chat. Si no hay una tarea concreta, pedila antes de abrir workers.

## Preflight de confianza

1. Confirmá que el proyecto tiene `pandi-ultracode-cursor` disponible en `node_modules/.bin/`. Si falta, explicá cómo
   instalarlo; no instales dependencias ni alteres la confianza del workspace por tu cuenta.
2. Explicá que el workflow corre como código confiable con capacidades host. Pedí una confirmación explícita de que el
   workflow y el workspace son confiables. Sin ella, detenete sin lanzar workers.
3. Con esa confirmación, corré `cursor-ultracode` con el binario local, un input JSON correctamente escapado y límites
   explícitos. Su primera fase es el Contract Gate; luego sigue single-agent o fan-out según ese contrato:

   ```bash
   ./node_modules/.bin/pandi-ultracode-cursor run cursor-ultracode \
     --input '<JSON con request y context>' \
     --concurrency 4 --max-agents 8 --trust-workspace
   ```

4. Leé `result.json` y `summary.md` del `runDir` informado. Si el veredicto es bloqueado, mostrale únicamente las
   preguntas que requieren decisión humana.
5. Reportá la ruta elegida, evidencia, ramas fallidas o vacías y el siguiente paso. No reemplaces el resultado del
   runner con una síntesis sin evidencia.

## Límites de esta primera entrega

- El runner es trusted-workspace only. `node:vm` es un contexto de evaluación, no un sandbox; no ejecutes workflows no
  confiables.
- Los workers son de solo lectura por defecto. No eleves permisos ni habilites escritura o shell.
- No afirmes compatibilidad con opciones de Pi que el runner rechaza por no poder aplicarlas por worker. Mostrá el error
  y proponé el ajuste mínimo.
- Siempre devolvé el `runDir`, qué verificaste, cualquier rama fallida y el siguiente paso. No confundas una síntesis de
  agentes con una verificación.
