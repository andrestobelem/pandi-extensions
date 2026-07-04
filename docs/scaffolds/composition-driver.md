# composition-driver

> Workflow padre: descubre claims, delega la verificación a verify-claims-lib y sintetiza.

## En 30 segundos

Es la referencia canónica de composición: un workflow padre (`composition-driver`)
que hace su propio trabajo (descubrir claims) y delega la parte reutilizable
(verificarlos) a un sub-workflow independiente (`verify-claims-lib`) vía
`workflow(name, args)`. Elegilo cuando quieras ver el patrón "padre + librería"
funcionando de punta a punta, o cuando necesites ese flujo exacto
descubrir → verificar → sintetizar sobre un texto.

## Cómo lanzarlo

```sh
/workflow new fact-check-sse --pattern=composition-driver
```

Input típico:

```json
{ "topic": "claims en nuestro doc de paridad SSE", "maxClaims": 8, "skeptics": 3 }
```

Requiere que exista, junto a este scaffold, un workflow de proyecto o global
llamado `verify-claims-lib` (ver `docs/scaffolds/verify-claims-lib.md`); si no
está disponible, el workflow degrada en vez de fallar (ver más abajo).

## Diagrama

```mermaid
flowchart TD
    Input["input: topic, maxClaims?, skeptics?"] --> Discover
    subgraph Discover["Fase Discover"]
        Finder["agent: claim-finder (haiku, low)\nschema CLAIMS"]
    end
    Discover --> Clamp["clamp maxClaims (1..20)"]
    Clamp --> Empty{"¿hay claims?"}
    Empty -->|no| NoClaims["return 'No falsifiable claims found to verify.'"]
    Empty -->|si| Verify

    subgraph Verify["Fase Verify: delega a sub-workflow"]
        Sub["workflow('verify-claims-lib', {claims, skeptics, topic})"]
        Fallback["catch: degradar\nverified = claims, note = skipped"]
        Sub -->|error| Fallback
    end

    Verify --> Synthesize
    subgraph Synthesize["Fase Synthesize"]
        Judge["agent: composition-synthesis (opus, high)"]
    end
    Synthesize --> Output["return synthesis (texto)"]
```

## Qué hace

`composition-driver` es un workflow de tres fases que ilustra composición
real entre workflows: no reimplementa la verificación de claims, sino que la
delega a `verify-claims-lib` pasándole exactamente el contrato que ese
sub-workflow espera (`{ claims, skeptics, topic }`). El padre se queda con las
dos partes que le son propias: encontrar los claims en el texto de entrada y
sintetizar el resultado final para el usuario.

La fase Discover usa un único agente barato (`haiku`, effort `low`) con un
JSON Schema estricto para que la salida sea siempre parseable, evitando tener
que hacer "safe-parse" de prosa libre. La fase Verify no ejecuta agentes
directamente: invoca el sub-workflow con `workflow(...)` y, si esa invocación
falla (por ejemplo por límite de profundidad de anidamiento), degrada
gracefully en vez de abortar todo el run. La fase Synthesize usa un modelo más
caro (`opus`, effort `high`) porque ahí es donde se necesita criterio para
preservar incertidumbre y citar evidencia.

Todo el contenido no confiable (el `topic` del usuario, los resultados de
verificación) se envuelve con `fence(...)`, un delimitador derivado de un hash
del contenido: un payload malicioso no puede falsificar el marcador de cierre
porque cambiar el contenido cambia el hash. Cada prompt de agente instruye
explícitamente tratar ese contenido como datos, nunca como instrucciones.

## Cuándo usarlo

- Fact-checking de un documento (extraer afirmaciones verificables y
  contrastarlas).
- Separar "descubrimiento" de "verificación reutilizable" en workflows
  distintos.
- Como referencia canónica de composición cuando vas a escribir tu propio
  workflow padre que llama a un sub-workflow con `workflow(name, args)`.

No lo uses si:

- Solo necesitás verificar claims que ya tenés (usá `verify-claims-lib`
  directo, sin la fase de descubrimiento).
- No tenés desplegado el sub-workflow `verify-claims-lib`: el resultado sigue
  siendo válido pero la verificación queda degradada (`note: "verification
  skipped (nesting depth exceeded)"`).

## Cómo funciona

1. **Parseo de input y overrides.** `args` se parsea a JSON (string u objeto);
   si falla, cae a `{}`. Soporta overrides globales (`input.model`,
   `input.effort`, `input.tools`, `input.skills`, `input.excludeTools`) y
   overrides por rol vía `input.models[role]`, `input.efforts[role]`,
   `input.toolsByRole[role]`, `input.skillsByRole[role]`,
   `input.excludeByRole[role]`, con precedencia rol > global > default del
   call-site.
2. **Discover** (`agent`): un único agente `claim-finder` (`haiku`, effort
   `low`) recibe el `topic` fenceado y devuelve hasta `maxClaims` claims
   concretos y falsables como `{ id, claim, evidence }`, forzado por el
   schema `CLAIMS` (objeto, `additionalProperties: false`). Si la respuesta no
   es un array o los items no tienen `.claim`, se descartan silenciosamente;
   si no queda ningún claim, el workflow retorna temprano el mensaje `"No
   falsifiable claims found to verify."`. Si el finder devolvió más de
   `maxClaims`, se loguea el recorte.
3. **Verify** (`workflow`): llama a `workflow("verify-claims-lib", { claims,
   skeptics, topic })`. Ese sub-workflow corre su propia fase con
   `parallel(...)` (jurado de skeptics por claim) y devuelve `{ verified,
   dropped, votes, coverage }`. Si la llamada lanza (por ejemplo, límite de
   anidamiento excedido), el `catch` loguea el error y arma un resultado
   degradado: `{ verified: claims, note: "verification skipped (nesting depth
   exceeded)" }`, es decir, todos los claims pasan sin contraste adversarial.
4. **Synthesize** (`agent`): un agente `composition-synthesis` (`opus`,
   effort `high`) recibe el resultado de verificación (compactado a 50 000
   caracteres) fenceado como datos no confiables, y redacta la síntesis final
   preservando incertidumbre, citando evidencia y mencionando explícitamente
   que la verificación fue delegada a `verify-claims-lib`. Ese texto es el
   valor de retorno del workflow.

No hay `writeArtifact` en este scaffold: el único output es el valor de
retorno de la fase Synthesize. El caching de agentes es el del runtime de
Dynamic Workflows (no hay lógica de cache explícita en el código).

## Input y output

| Campo | Tipo | Default / clamp |
|---|---|---|
| `topic` (o `question` / `text`) | string | requerido; si falta, lanza error |
| `maxClaims` | number | default `8`; clamp a `[1, 20]` (se loguea si se recorta) |
| `skeptics` | number | default `3`; clamp a `[1, 8]` antes de pasarlo al sub-workflow (que a su vez lo vuelve a clampear a `[1, 64]`) |
| `model` / `effort` | string | override global aplicado a todos los nodos (`agent`, `claim-finder`, `composition-synthesis`) |
| `models[role]` / `efforts[role]` | object | override por rol (`claim-finder`, `composition-synthesis`) |
| `tools` / `toolsByRole`, `skills` / `skillsByRole`, `excludeTools` / `excludeByRole` | array/object | igual patrón global vs. por rol |

**Output:** el texto de síntesis devuelto por el agente `composition-synthesis`
(sin schema forzado, prosa libre). No escribe artifacts a disco.

## Fases

1. **Discover** — un agente (`haiku`, low) descubre hasta `maxClaims` claims
   falsables sobre el `topic`.
2. **Verify** — delega la verificación completa a `workflow("verify-claims-lib",
   ...)`; degrada a "sin verificación" si la invocación falla.
3. **Synthesize** — un agente (`opus`, high) redacta la síntesis final citando
   evidencia y mencionando la delegación.
