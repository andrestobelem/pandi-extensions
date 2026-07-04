# recursive-compose

> Referencia (pi, profundidad ≤ 3): un nodo vuelve a gatear una sub-tarea con
> contract-gate y luego despacha vía router — recursión acotada.

## En 30 segundos

Este scaffold no hace trabajo por sí mismo: encadena dos workflows ya
existentes. Primero vuelve a pasar la tarea por el gate de Fase-0
(`contract-gate`) para re-scopearla, y si el gate dice que conviene un
dynamic workflow, despacha el scaffold recomendado a través de `router`.
Elegilo cuando quieras ver (o reutilizar) el patrón "gate → compone
recursivamente" — por ejemplo, un nodo que re-evalúa una sub-tarea antes de
seguir bajando en profundidad.

## Cómo lanzarlo

```
/workflow new mi-run --pattern=recursive-compose
```

Input típico:

```json
{
  "task": "audit + fix the SSE decoder",
  "context": "opcional, texto libre",
  "args": { "limit": 20 }
}
```

`task` es obligatorio (alias: `request`, `text`). `args` se reenvía tal cual
al workflow que finalmente se despache.

**Runtime:** este scaffold anida `workflow(...)`, así que necesita un
runtime que permita profundidad ≥ 2. En pi, exportá
`PI_DYNAMIC_WORKFLOWS_MAX_DEPTH<=3` (3 alcanza para esta cadena). En la
herramienta Workflow de Claude Code (profundidad 1) el segundo salto
(router → scaffold elegido) dispara el guard de recursión; el código lo
atrapa y devuelve `status: "DEPTH_BLOCKED"` en vez de romper.

## Diagrama

```mermaid
flowchart TD
    Start(["Input: task, context, args"]) --> Gate["Fase Gate<br/>workflow('contract-gate', generate:false)"]
    Gate -->|"error de profundidad"| DepthGate["DEPTH_BLOCKED (stage: gate)"]
    Gate -->|"status != PROCEED"| Needs["NEEDS_CLARIFICATION<br/>+ gate.questions"]
    Gate -->|"status == PROCEED"| Shape{"routing.shape"}
    Shape -->|"no es 'dynamic-workflow'"| NoCompose["NO_COMPOSE<br/>+ rewrittenPrompt"]
    Shape -->|"'dynamic-workflow'"| Dispatch["Fase Dispatch<br/>workflow('router', runSelected:true)"]
    Dispatch --> Router["router elige y ejecuta el scaffold recomendado"]
    Router -->|"scaffold elegido es a su vez un composer"| Deeper["sub-workflow interno (profundidad 3)"]
    Dispatch -->|"error de profundidad"| DepthDispatch["DEPTH_BLOCKED (stage: dispatch)"]
    Router --> Done["DONE<br/>+ gate + dispatched"]
```

## Qué hace

`recursive-compose` es un ejemplo de composición pura: no define ningún
`agent()` propio, solo orquesta dos workflows ya existentes del catálogo.
Primero llama a `contract-gate` con `generate:false` para que el gate
re-scopee la tarea sin volver a anidar (eso reservaría presupuesto de
profundidad para el paso siguiente). Si el gate no da `PROCEED`, el
scaffold corta ahí devolviendo las preguntas de clarificación.

Si el gate da `PROCEED` y su `routing.shape` es `"dynamic-workflow"`, el
scaffold pasa el `rewrittenPrompt` del gate a `router` con
`runSelected:true`, para que el router elija el scaffold adecuado y lo
ejecute de una. El presupuesto sugerido por el gate (`resourcePlan.models`
/ `resourcePlan.efforts`) se reenvía dentro de `args` al workflow
despachado, para que el trabajo profundo corra con el tier que el gate
recomendó.

Cada llamada anidada está envuelta en try/catch: si el runtime rechaza la
profundidad (recursion guard), el error se captura y se traduce a
`status: "DEPTH_BLOCKED"` con una nota de qué hacer, en vez de propagar la
excepción.

## Cuándo usarlo

- Necesitás el patrón de referencia "gate se re-aplica sobre sí mismo" para
  pipelines auto-similares (gate → compose → gate → compose...).
- Querés llevar el `resourcePlan` (presupuesto sugerido por el gate) hasta
  una corrida más profunda, sin recalcularlo.
- Buscás un ejemplo concreto de despacho recursivo acotado por profundidad.

**No lo uses si:**

- Ya sabés qué scaffold necesitás — llamalo directo, no hace falta re-gatear.
- Corrés bajo la herramienta Workflow de Claude Code y necesitás que el
  despacho realmente se ejecute (ahí topa el guard de profundidad y vuelve
  `DEPTH_BLOCKED`; usá pi para ver la cadena completa).

## Cómo funciona

**Fase Gate** — llama a `workflow("contract-gate", { request: task, context, generate: false })`.
`generate:false` evita que el propio `contract-gate` anide un nivel extra.
Si la llamada tira una excepción (guard de profundidad), retorna
`{ status: "DEPTH_BLOCKED", stage: "gate", error, note }`. Si el gate
responde pero `status !== "PROCEED"`, retorna
`{ status: "NEEDS_CLARIFICATION", questions, gate }`. Si `routing.shape`
no es `"dynamic-workflow"` (tarea trivial o de un solo agente), retorna
`{ status: "NO_COMPOSE", reason, rewrittenPrompt, gate }` sin componer más.

**Fase Dispatch** — solo se alcanza si el gate dio `PROCEED` y
`routing.shape === "dynamic-workflow"`. Construye `dispatchArgs` fusionando
los `args` de entrada con `models`/`efforts` del `resourcePlan` del gate (si
existen), y llama a
`workflow("router", { request: compact(gate.rewrittenPrompt), runSelected: true, args: dispatchArgs })`.
`compact()` trunca el prompt a 60000 caracteres para evitar payloads
gigantes entre workflows anidados. Si esta llamada falla por profundidad,
retorna `{ status: "DEPTH_BLOCKED", stage: "dispatch", error, note, gate }`.
Si tiene éxito, retorna `{ status: "DONE", gate, dispatched }`.

No usa `agent`, `agents`, `parallel` ni `pipeline` directamente — toda la
concurrencia, modelos y efforts vienen de lo que `contract-gate` y `router`
(y el scaffold que éste elija) hagan internamente. No hay caching propio ni
manejo de fallos parciales más allá del try/catch por llamada anidada.

## Input y output

**Input:**

| Campo | Requerido | Descripción |
|---|---|---|
| `task` (alias `request`, `text`) | sí | La tarea a re-gatear y potencialmente despachar. |
| `context` | no | Contexto libre reenviado a `contract-gate`. |
| `args` | no (default `{}`) | Objeto reenviado al workflow finalmente despachado; se le suman `models`/`efforts` del `resourcePlan` del gate si existen. |

**Output** (uno de los siguientes `status`):

| status | Cuándo | Payload |
|---|---|---|
| `DONE` | el router despachó con éxito | `{ gate: { improvedTask, routing, resourcePlan }, dispatched }` |
| `NEEDS_CLARIFICATION` | el gate no dio `PROCEED` | `{ questions, gate }` |
| `NO_COMPOSE` | el gate resolvió que no hace falta un dynamic workflow | `{ reason, rewrittenPrompt, gate }` |
| `DEPTH_BLOCKED` | el runtime rechazó una llamada anidada por profundidad | `{ stage: "gate"\|"dispatch", error, note, gate? }` |

No escribe artifacts propios (`writeArtifact`); cualquier artifact viene del
workflow despachado.

## Fases

1. **Gate** — re-scope de Fase-0 vía `workflow('contract-gate', { generate: false })`.
2. **Dispatch** — despacho del scaffold recomendado vía `workflow('router', { runSelected: true })`.
