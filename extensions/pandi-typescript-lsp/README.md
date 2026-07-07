# @pandi-coding-agent/pandi-typescript-lsp

Feedback de diagnósticos de TypeScript para Pi: después de un turno que escribió o editó TypeScript, ejecuta `tsc --noEmit` sobre el/los proyecto(s) relevante(s) y reporta errores solo para los archivos que ese turno tocó. Usalo cuando estés iterando TypeScript dentro de una sesión de Pi y quieras feedback del compilador sin salir del chat ni correr `tsc` a mano.

## En 30 segundos

```bash
pi install npm:@pandi-coding-agent/pandi-typescript-lsp
```

Por defecto, el chequeo corre automáticamente en `agent_end`, acotado a los archivos tocados por el turno. Si encuentra algo, vas a ver el reporte en tu siguiente turno, sin hacer nada:

```text
Diagnósticos de TypeScript (1):
src/foo.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.
```

Ese chequeo automático también limpia la lista de archivos tocados, así que si corrés `/tsc run` enseguida solo va a decir "No se tocó ningún archivo TypeScript en este turno." — editá primero otro `.ts` y después lanzalo a demanda:

```text
/tsc run
Diagnósticos de TypeScript (1):
src/foo.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.
```

## Qué obtenés

- Feedback automático y no bloqueante en `agent_end` — advisory por defecto, autofix opcional.
- `typescript_diagnostics` — herramienta de modelo para chequeos bajo demanda.
- `/tsc` — comando slash para controlar y ejecutar chequeos vos mismo.

## Instalación

Desde este repositorio:

```bash
pi install ./extensions/pandi-typescript-lsp          # global (tu usuario)
pi install -l ./extensions/pandi-typescript-lsp       # local al proyecto
pi --no-extensions -e ./extensions/pandi-typescript-lsp   # prueba única, sin cargar nada más
```

## Comandos

| Comando | Qué hace |
| --- | --- |
| `/tsc` o `/tsc status` | Muestra estado habilitado, modo, scope, autofix y máximo. |
| `/tsc on` / `/tsc off` | Habilita o deshabilita el feedback automático. |
| `/tsc run` | Ejecuta un chequeo ahora y reporta el resultado. |
| `/tsc scope touched\|project` | Define el scope por defecto (archivos tocados vs. proyecto completo). |
| `/tsc autofix on\|off` | Alterna entre entrega advisory y autofix. |
| `/tsc max <n>` | Limita cuántos diagnósticos se muestran. |
| `typescript_diagnostics` | Herramienta de modelo: ejecuta diagnósticos con `scope` opcional (`touched` por defecto, o `project` para `<cwd>/tsconfig.json`); devuelve un resumen textual y `details` estructurados. |

## Cómo funciona

Los diagnósticos se disparan en `agent_end` — cuando termina todo el turno — y no después de cada escritura. A mitad del turno, un archivo suele quedar a medio editar y eso reportaría errores transitorios; chequear una sola vez en el borde, acotado a los archivos tocados, da señal honesta con ruido mínimo.

Elegí el modo de entrega con `/tsc autofix on|off`:

| Modo | Ante errores, `agent_end`... | Seguridad de loop |
| --- | --- | --- |
| **advisory** (default) | envía un mensaje no bloqueante en el siguiente turno | los reportes idénticos se deduplican y nunca se reinyectan |
| **autofix** (opt-in) | dispara un turno de seguimiento para que el agente los corrija ahora | limitado a 1 arreglo auto-disparado por prompt, más la misma deduplicación — nunca puede entrar en loop |

## Limitaciones y notas de seguridad

- **No es un LSP completo.** Aunque el nombre diga eso, esto solo da diagnósticos — sin hover, sin go-to-definition, sin completions. Pensalo como: "¿mis ediciones de TypeScript siguen compilando?".
- **No bloquea por diseño.** Nunca bloquea una llamada a tool; si falta `tsconfig` o `tsc`, queda en un NO-OP silencioso con una única advertencia advisory, nunca en una sesión rota.
- `tsc` siempre se lanza con un array argv — nunca con un string de shell — así que las rutas no pueden inyectar comandos.
- Una corrida que supera el presupuesto de timeout se muestra como inconclusa ("timed out"), nunca como chequeo limpio, y no altera el estado de dedupe advisory.

## Detalles

Orden de resolución de `tsc`:

1. `PI_TS_LSP_TSC` — ruta absoluta a un `tsc.js`, ejecutado con el `node` actual.
2. El `node_modules/typescript/bin/tsc` más cercano, subiendo desde el directorio del tsconfig.
3. Respaldo: `npx tsc`.

Variables de entorno:

| Variable | Predeterminado | Significado |
| --- | --- | --- |
| `PI_TS_LSP` | `on` | `on` / `off` — habilita la extensión |
| `PI_TS_LSP_MODE` | `advisory` | `advisory` / `autofix` |
| `PI_TS_LSP_MAX` | `20` | Máximo de diagnósticos mostrados (entero positivo) |
| `PI_TS_LSP_AUTOFIX` | `off` | `on` / `off` — habilita turnos de autofix |
| `PI_TS_LSP_TSC` | (auto) | Ruta absoluta al `tsc.js` a ejecutar |
| `PI_TS_LSP_TIMEOUT_MS` | `60000` | Presupuesto de tiempo por corrida de `tsc` (entero positivo, ms) |

La entrega autofix necesita AMBAS configuraciones juntas — `PI_TS_LSP_MODE=autofix` solo sigue en advisory, porque el código recién cambia a autofix cuando `mode === "autofix" && autofix` (`PI_TS_LSP_AUTOFIX=on`).

## Relacionado

Para instalar el paquete completo de extensiones y skills, instalá la raíz del repositorio.
