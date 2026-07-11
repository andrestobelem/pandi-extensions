# race

`race()` abre varias ramas, se queda con el primer valor aceptado y señala las demás para cancelarlas. Usalo cuando
tenés intentos redundantes para el mismo objetivo y te importa la respuesta aceptable más rápida, no la mejor. La
cancelación es cooperativa: cada rama debe reenviar su `signal` a una primitiva que la soporte.

```js
const { winner, index, status } = await race(
  endpoints.map((url) => (signal) => agent(`Answer via ${url}: ${q}`, { signal })),
);
if (status === "won") log(`endpoint ${index} answered first`);
```

**Runtime:** runtime de pi (no en la herramienta Workflow de Claude Code)

## Firma

`race(thunks, { accept? }) → Promise<{ winner, index, status, errors? }>`

- `thunks`: cada `thunk` es `(signal) => Promise`.
- `accept`: decide qué cuenta como victoria. El valor por defecto es `(value) => value != null`, así que un `null`
  resuelto cuenta como declinación, no como victoria.

Pasá ese `signal` a `agent()`/`agents()`/`ask()`/`bash()`/`sleep()`. La señal solicita terminar subagentes y comandos,
descartar diálogos y rechazar esperas; `race()` no espera a observar que cada limpieza haya terminado.

## Devuelve

- `status: "won"` → `winner` es el valor aceptado y `index` su posición.
- `status: "empty"` → ninguna rama fue aceptada; `winner` es `null` e `index` es `-1`.
- `errors?: [{ index, error }]` → aparece cuando una o más ramas hicieron REJECT (lanzaron una excepción), para que un
  bug real en un `thunk` se pueda depurar en vez de parecer una declinación limpia de todas las ramas. Una declinación
  común (`null` resuelto) no agrega ninguna entrada a `errors`.

## Cuándo usarlo y cuándo no

| Situación                                                     | Primitiva                                                               |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Cubrir una llamada lenta o inestable con intentos redundantes | `race` — optimiza latencia                                              |
| Elegir la mejor respuesta por _calidad_, no por velocidad     | `tournament` / `judge-escalate` — un juez debe ver todas las candidatas |
| Ejecutar N cosas y conservar todos los resultados             | `agents` / `parallel`                                                   |

## Advertencias

- `thunks` DEBE ser un arreglo no vacío de funciones que reciban `signal`: `race([])` o entradas que no sean funciones
  hacen throw sincrónico.
- Propagá `signal` a cada operación cancelable. Una promesa arbitraria que lo ignore sigue corriendo después de que la
  carrera se decidió.
- `workflow()` y los helpers de filesystem/artifacts no aceptan cancelación de rama: diferí sus efectos hasta después
  de elegir al ganador.
- `errors` es aditivo: aunque haya rechazos, `winner`/`index`/`status` conservan su significado normal. Para saber si
  hubo ganador, mirá `status`, no `errors`.

## Example

```js
export default async function main(ctx, input) {
  const endpoints = input.endpoints ?? [];
  const { winner, index, status, errors } = await race(
    endpoints.map((url) => (signal) => agent(`Fetch a status summary from ${url}`, { signal })),
    { accept: (value) => typeof value === "string" && value.length > 0 },
  );
  if (status === "empty") throw new Error(`no endpoint answered: ${JSON.stringify(errors)}`);
  return { source: endpoints[index], summary: winner };
}
```
