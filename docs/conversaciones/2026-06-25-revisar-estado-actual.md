# Conversación: revisar estado actual

Fecha: 2026-06-25
Tema: creación y ejecución de un workflow para revisar el estado actual del repositorio.

## Contexto

El usuario pidió crear un workflow para revisar el estado actual del proyecto y luego pidió guardar en `docs/` todo lo realizado y la conversación.

## Transcripción resumida

### Usuario

> crear un workflow para revisar el estado actual

### Asistente

Se activó la skill de dynamic workflows y se revisó su documentación local:

- `skills/dynamic-workflows/SKILL.md`

Luego se inspeccionó el template del runtime de workflows y workflows existentes del proyecto.

Acciones realizadas:

- Se solicitó template con `dynamic_workflow action=template`.
- Se listaron workflows del proyecto.
- Se leyó `.pi/workflows/review-dynamic-workflows.js` como referencia.
- Se inspeccionó el estado de Git.
- Se leyó `package.json`.
- Se revisó la estructura de `examples/`, `skills/` y `.pi/workflows/`.
- Se creó `.pi/workflows/revisar-estado-actual.js`.
- Se generó graph del workflow.
- Se validó sintaxis con `node --check`.
- Se corrigió el comando de árbol de archivos dentro del workflow.

Respuesta dada al usuario:

> Listo. Creé el workflow: `./.pi/workflows/revisar-estado-actual.js` ... Si quieres, lo ejecuto ahora.

### Usuario

> dale

### Asistente

Se ejecutó el workflow con:

```json
{
  "action": "run",
  "name": "revisar-estado-actual",
  "scope": "project",
  "input": {
    "runChecks": false,
    "maxFiles": 2000
  },
  "concurrency": 4,
  "maxAgents": 6,
  "timeoutMs": 900000,
  "agentTimeoutMs": 600000
}
```

Resultado inmediato: la herramienta no devolvió resultado visible.

### Usuario

> continua

### Asistente

Se inspeccionaron runs con `dynamic_workflow action=runs`.

Hallazgo:

- El run `2026-06-25T05-13-09-630Z-revisar-estado-actual-653459f8` quedó en estado `stale`.
- Se había recolectado baseline correctamente.
- Se habían iniciado 4 subagentes.

Se inspeccionó:

- `status.json`
- `baseline.json`

Luego se relanzó en background con menor concurrencia:

```json
{
  "action": "start",
  "name": "revisar-estado-actual",
  "scope": "project",
  "input": {
    "runChecks": false,
    "maxFiles": 2000
  },
  "concurrency": 2,
  "maxAgents": 6,
  "timeoutMs": 900000,
  "agentTimeoutMs": 600000
}
```

Nuevo run:

```text
2026-06-25T05-16-10-490Z-revisar-estado-actual-a47adcb7
```

Estado observado inicialmente:

- `running` en background.
- Inició baseline correctamente.
- Inició 2 subagentes:
  - `git-y-estructura`
  - `implementacion-runtime`

Estado final observado más tarde:

- `completed`.
- Ejecutó 5 agentes en total, incluyendo síntesis.
- Generó `estado-actual.md`, `reviews.json`, `result.json` y artifacts de agentes.

### Usuario

> en docs vamos a guardar todo lo que hicimos y las conversaciones

### Asistente

Se decidió crear documentación persistente bajo `docs/`:

- `docs/README.md`
- `docs/workflows/revisar-estado-actual.md`
- `docs/conversaciones/2026-06-25-revisar-estado-actual.md`

### Usuario

> anotá en la memoria cómo trabajamos

### Asistente

Se creó una memoria de trabajo persistente para dejar registradas las preferencias y convenciones de colaboración:

- `docs/memoria.md`

También se agregó el enlace correspondiente en `docs/README.md`.

### Usuario

> quiero que por default, pi evalue la tarea y decida si es mejor usar un workflow para resolverla es el modo ultracode de claude, investigalo. pero lo quiero siempre activo

### Asistente

Se investigó el comportamiento de Claude Code `ultracode` y se implementó un router always-on en la extensión:

- Hook usado: `before_agent_start`.
- Comportamiento: inyectar instrucciones para evaluar cada tarea y decidir si conviene workflow.
- Tareas simples siguen por el flujo normal.
- Tareas complejas deben usar `dynamic_workflow` con límites explícitos.
- Se agregó `/ultracode-mode status|on|off` para inspeccionar o cambiar el modo durante la sesión.
- Se documentó la investigación en `docs/investigaciones/2026-06-25-ultracode-always-on.md`.
- Se validó carga de la extensión con `pi --no-extensions -e ./extensions/dynamic-workflows.ts --list-models __no_such_model__`.
- Se validó el comando nuevo con `pi --no-extensions -e ./extensions/dynamic-workflows.ts --no-session -p "/ultracode-mode status"`.

## Archivos creados o modificados durante esta conversación

- `.pi/workflows/revisar-estado-actual.js`
- `extensions/dynamic-workflows.ts`
- `README.md`
- `skills/dynamic-workflows/SKILL.md`
- `docs/README.md`
- `docs/memoria.md`
- `docs/investigaciones/2026-06-25-ultracode-always-on.md`
- `docs/workflows/revisar-estado-actual.md`
- `docs/conversaciones/2026-06-25-revisar-estado-actual.md`

## Estado Git observado

Al inicio de la documentación, el repo mostraba:

```text
 M .gitignore
 M README.md
?? .pi/
?? examples/
?? extensions/
?? package.json
?? skills/
```

## Pendientes

- Decidir qué archivos de `.pi/` se versionan.
- Agregar scripts de verificación al `package.json` si el paquete va a publicarse o probarse de forma repetible.
- Decidir si el modo ultracode always-on debe forzar `thinking=xhigh` o mantenerse como router sin cambiar coste/modelo.
- Endurecer ejemplos que conceden `bash` a subagentes. Resuelto parcialmente: `examples/workflows/deep-research.js` ya no concede `bash` a subagentes; mantiene `web_search`/read-only.

## Nota posterior: wake on workflow completion

El usuario pidió que los workflows despierten al agente cuando terminen. Se implementó en `extensions/dynamic-workflows.ts`:

- `makeWorkflowWakePrompt(result)` crea el follow-up.
- `wakeAgentForWorkflowResult(pi, ctx, result)` envía `pi.sendUserMessage(...)` al completar/fallar.
- No despierta para runs cancelados para evitar ruido.
- Se validó carga de extensión con `pi --no-extensions -e ./extensions/dynamic-workflows.ts --list-models __no_such_model__`.

## Nota posterior: mejora de prompts de workflows

El usuario pidió usar lo aprendido sobre patrones de workflows agénticos para mejorar los prompts de los workflows dinámicos.

Se aplicaron estos patrones:

- Fan-out independiente.
- Contratos de evidencia.
- Formatos de salida fijos.
- Síntesis como juez (`synthesis-as-judge`).
- Crítica adversarial.
- Manejo explícito de fallas parciales.
- Seguridad por defecto con prompts “no edites archivos” y tools read-only en auditorías.

Archivos actualizados:

- `.pi/workflows/*.js`
- `examples/workflows/*.js`
- `README.md`
- `skills/dynamic-workflows/SKILL.md`
- `docs/investigaciones/2026-06-25-prompt-patterns-workflows.md`
- `docs/memoria.md`

Validación ejecutada:

```text
node --check .pi/workflows/*.js examples/workflows/*.js
pi --no-extensions -e ./extensions/dynamic-workflows.ts --list-models __no_such_model__
```
