# args

`args` es la forma en que quien lanza una corrida le pasa parámetros al script:
el texto del pedido, los paths objetivo o los budgets de `model`/`effort`.
Usalo cuando tu script necesite saber qué se le pidió, en vez de hardcodearlo.

```js
const input = typeof args === "string" ? JSON.parse(args) : (args ?? {});
console.log(input.request);
```

**Runtime:** compartido (pi + Claude Code)

**Signature:** `args` (value) — el input del workflow

Es el input que se le pasa al workflow (`dynamic_workflow` `input`, o
`Workflow` `args` en Claude). Un script de nivel superior lo lee como la global
`args`; `export default async function main(ctx, input)` también lo recibe como
`input`.

**Returns:** el valor de input (un objeto, o un JSON string en Claude).

## Cuándo usarlo / cuándo no

- **Usalo** para leer la tarea o configuración con la que se lanzó la corrida
  (`request`, rutas objetivo, budgets de `model`/`effort`, mapas por rol).
- **No lo uses** como estado mutable: tratá `args` como los parámetros de solo
  lectura de la corrida.

## Cosas a tener en cuenta

- **Parseá defensivamente:** en Claude, `args` puede llegar
  **JSON-stringified**. Protegelo con
  `typeof args === "string" ? JSON.parse(args) : args`.
- Los budgets por nodo (`model`, `models`, `efforts`) suelen pasarse dentro de
  `args`.

## Example

```js
export default async function main() {
  const input = typeof args === "string" ? JSON.parse(args) : (args ?? {});
  const request = input.request ?? "";
  return await agent(request, { model: input.model, effort: input.effort });
}
```
