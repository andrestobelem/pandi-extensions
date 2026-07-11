# sleep

`sleep(ms)` pausa un paso del workflow durante `ms` milisegundos: es una espera simple y cancelable. Usalo cuando
necesitás una pausa deliberada, por ejemplo un backoff suave entre probes de polling.

```js
for (let i = 0; i < maxTries; i++) {
  const { stdout } = await bash("check-ready.sh");
  if (stdout.includes("ready")) break;
  await sleep(2000);
}
```

**Runtime:** pi runtime

**Firma:** `sleep(ms, options?) → Promise<void>` con `options.signal?`.

**Devuelve:** nada. La promesa resuelve después de la espera, o rechaza si la corrida se cancela o si el `signal`
explícito se aborta.

## Cuándo usarlo y cuándo no

| Situación                                               | ¿Usar `sleep`?                         |
| ------------------------------------------------------- | -------------------------------------- |
| Backoff entre probes de polling                         | Sí                                     |
| Esperar un intervalo fijo y conocido                    | Sí                                     |
| Hacer busy-polling de trabajo que el harness ya trackea | No — dejá que el harness lo trackee    |
| “Arreglar” una race condition                           | No — secuenciá con `await` en su lugar |

## Ojo

- **Cancelable.** La espera siempre queda ligada a la señal de la corrida. Dentro de `race()`, usá
  `sleep(ms, { signal })` para que también se detenga cuando la rama pierde.
- **No determinismo.** Una duración derivada de `Date.now()` es no determinista. Evitá usar esos valores en prompts o
  cache keys.

## Example

```js
export default async function main() {
  const maxTries = 5;
  for (let i = 0; i < maxTries; i++) {
    const { stdout } = await bash("curl -sf http://localhost:3000/health");
    if (stdout.includes("ok")) {
      return await agent("Service is healthy, summarize readiness.");
    }
    await sleep(2000);
  }
  return "service never became ready";
}
```
