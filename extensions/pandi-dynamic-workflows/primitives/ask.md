# ask

Pausa una rama para pedirle una decisión a una persona en medio de la corrida. Usalo cuando el workflow no puede decidir
con seguridad por sí solo: hace falta aprobación para una acción riesgosa, o la elección depende de un juicio que el
modelo no tiene.

```js
const proceed = await ask("Apply the migration to all 200 files?", {
  default: false, // fallback headless: sin UI → responde "no"
});
if (!proceed) return { skipped: true };
```

**Runtime:** pi runtime (no está disponible en la Claude Code Workflow tool)

**Firma:** `ask(question, options?) → Promise<string | boolean>`

`options.kind` elige el diálogo: `input` (texto libre, por defecto), `confirm` (sí/no — se infiere cuando `default` es
boolean), o `select` (a partir de `choices` — se infiere cuando `choices` está definido). Otras opciones: `placeholder`,
`default`, `timeoutMs`, `cache` (por defecto `true`), `secret` (nunca se persiste ni se reproduce) y `signal` (para
descartar el diálogo de la rama perdedora de `race()`).

**Devuelve:** un **string** para `input`/`select`, un **boolean** para `confirm`.

## Cuándo usarlo y cuándo no

| Situación                                                                                      | ¿Usar `ask()`?                                  |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Un draft redactado por la persona usuaria necesita una aprobación humana a mitad de la corrida | Sí                                              |
| Un scaffold autónomo de catálogo pensado para correr sin supervisión                           | No — inferilo en su lugar (ver `contract-gate`) |
| Un scaffold cross-runtime (también debe correr en Claude Code Workflow)                        | No — es una primitiva solo de pi                |
| Un diálogo perdedor dentro de `race()`                                                         | Sí, pasá `{ signal }` para auto-descartarlo     |

## Puntos a tener en cuenta

- **Seguro al reanudar:** la respuesta se journaled por `(key, occ)` y se reproduce en `resume`; no se vuelve a
  preguntar, salvo que `cache: false`.
- **Honesto en modo headless:** con `hasUI:false` usa `options.default` o lanza un error claro; nunca queda colgado. A
  diferencia de `agent()`, `ask()` **no** traga errores: un error del host hace reject (aparece como un error lanzado).
- **Tipo ambiguo:** si pasás `choices` y además un `default` boolean, lanza error; definí `options.kind` explícitamente
  para desambiguar.
- **`select` necesita que su `default` esté en `choices`** y `choices` debe ser un array no vacío.
- `secret: true` omite por completo el journal: la respuesta nunca se escribe a disco y se volverá a pedir en `resume`.

## Example

```js
export default async function main(ctx, input) {
  const proceed = await ask(`Deploy ${input.target} to production?`, {
    kind: "confirm",
    default: false,
  });
  if (!proceed) return { skipped: true, reason: "declined by human" };
  const result = await agent(`Ejecutá el deployment para ${input.target}`);
  return { deployed: true, result };
}
```
