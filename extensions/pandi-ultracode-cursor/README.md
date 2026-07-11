# @pandi-coding-agent/pandi-ultracode-cursor

Ejecutá los workflows portables de Ultracode desde Cursor, sin instalar ni iniciar Pi. El plugin local ofrece
`/ultracode` dentro del chat; el runner conserva artifacts y journal bajo `.cursor/ultracode/runs/` y usa
`cursor-agent --print` para cada llamada a `agent()`. Usalo cuando necesitás orquestación visible y reanudable; para una
consulta o edición puntual, usá Cursor directamente. 🐼

Este runner es **trusted-workspace only**: ejecutá únicamente workflows y workspaces que hayas revisado y decidido
confiar. `run` y `resume` rechazan la ejecución salvo que pases `--trust-workspace` de forma explícita.

## Inicio rápido

Necesitás Node 22+ y [Cursor CLI](https://cursor.com/cli) autenticado. Instalá el runner y verificá que encuentra la
CLI:

```bash
npm install -D @pandi-coding-agent/pandi-ultracode-cursor
npx pandi-ultracode-cursor doctor
npx pandi-ultracode-cursor list
```

## Usarlo desde el chat de Cursor

El paquete incluye un plugin local: la entrada `/ultracode` hace Contract Gate, elige el camino más chico y deja visible
el `runDir`. Instalalo explícitamente; no escribimos `~/.cursor` por vos:

```bash
mkdir -p ~/.cursor/plugins/local
ln -s "$(node -p \"require('node:path').dirname(require.resolve('@pandi-coding-agent/pandi-ultracode-cursor/package.json'))\")/cursor-plugin" \
  ~/.cursor/plugins/local/pandi-ultracode
```

Reabrí Cursor y escribí `/ultracode <tu tarea>`. El comando usa el binario local del proyecto, por lo que la dependencia
sigue siendo explícita y versionable. Sus workers son read-only: si una tarea necesita escribir, el comando se detiene
para que decidas cómo habilitarlo.

Un workflow propio vive en `.cursor/ultracode/workflows/`. Este ejemplo lanza una llamada read-only:

```js
// .cursor/ultracode/workflows/hello.js
const input = JSON.parse(args);
return await agent(`Explicá en una frase: ${input.topic}.`, { label: "explain" });
```

```bash
npx pandi-ultracode-cursor run hello \
  --input '{"topic":"journals reanudables"}' --trust-workspace
```

El comando imprime `runDir` y el resultado. Revisá el run o reintentá una corrida interrumpida sin repetir llamadas que
ya quedaron en el journal:

```bash
npx pandi-ultracode-cursor view .cursor/ultracode/runs/<run-id>
npx pandi-ultracode-cursor resume .cursor/ultracode/runs/<run-id> --trust-workspace
```

## Qué puede ejecutar

El runner resuelve primero workflows del proyecto y luego el catálogo portable que distribuye
`@pandi-coding-agent/pandi-dynamic-workflows`:

| Fuente            | Ubicación                                        | Uso                                                                                    |
| ----------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Proyecto Cursor   | `.cursor/ultracode/workflows/<name>.js`          | Tu orquestación local.                                                                 |
| Host Cursor       | paquete `workflows/`                             | `cursor-ultracode`, el gateway genérico que empieza por Contract Gate.                 |
| Catálogo portable | dependencia `pandi-dynamic-workflows/scaffolds/` | `fan-out-and-synthesize`, `scout-fanout`, `contract-gate` y demás scaffolds canónicos. |

Los archivos comparten el formato portable: sin `import`, con `export const meta` opcional y un `return` final. El host
inyecta `args`, `agent`, `agents`, `parallel`, `pipeline`, `race`, `workflow`, `phase`, `log`, `ask`, `bash`,
`readFile`, `writeFile`, `appendFile`, `listFiles`, `limits`, `runId`, `runDir` y `cwd`.

```bash
# Valida sintaxis portable sin gastar una llamada de Cursor.
npx pandi-ultracode-cursor check fan-out-and-synthesize

# Corre un scaffold con parámetros explícitos.
npx pandi-ultracode-cursor run fan-out-and-synthesize \
  --input '{"files":["README.md"],"lens":"prose","limit":1}' \
  --concurrency 2 --max-agents 4 --trust-workspace
```

La composición `workflow(name, input)` tiene profundidad máxima 1, igual que el contrato portable de Claude Code. Un
sub-workflow no puede llamar a otro ni a sí mismo.

## Confianza, permisos y límites

La confianza en el workflow es obligatoria y las capacidades mutantes siguen requiriendo flags separados:

| Superficie                                                                          | Default                            | Para habilitarla                                                                                                                                                    |
| ----------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workers de Cursor                                                                   | `--mode ask` y `--sandbox enabled` | Es una política del worker, no una frontera del runner. Un nodo debe pedir `allowWrite: true` **y** el comando debe llevar `--allow-agent-write --trust-workspace`. |
| Workflow y workspace                                                                | Rechazados sin decisión            | Pasá `--trust-workspace` en cada `run` o `resume`; no existe un default `true`.                                                                                     |
| `writeFile` / `appendFile` del workflow                                             | Rechazado                          | `--allow-workflow-write`                                                                                                                                            |
| `bash()` del workflow                                                               | Rechazado                          | `--allow-workflow-shell`                                                                                                                                            |
| `ask()` sin TTY                                                                     | Rechazado                          | Pasá `default` en el workflow.                                                                                                                                      |
| `tools`, `skills`, `extensions`, `keys`, `env`, `agentType` o `provider` por agente | Rechazado                          | No hay equivalente seguro por worker en Cursor CLI.                                                                                                                 |

`--concurrency` limita workers simultáneos y `--max-agents` limita trabajadores lanzados en todo el run. Ambos límites
quedan en los artifacts. `--trust-workspace` registra una decisión que corresponde a la persona: el runner y la CLI
nunca la agregan solos.

`--workspace` selecciona el proyecto que Cursor abre, pero no restringe por sí mismo el acceso de sus tools al
filesystem. Tampoco tratamos `--sandbox enabled` como una frontera de aislamiento. `node:vm` aporta solamente un
contexto de evaluación: el workflow corre dentro del proceso del runner con las capacidades host inyectadas. No es un
sandbox de seguridad y no admite código no confiable.

Una futura frontera de proceso/OS está diseñada, pero no implementada, en
[`docs/research/2026-07-11-ultracode-process-os-boundary.md`](../../docs/research/2026-07-11-ultracode-process-os-boundary.md).

## Modelos y salida estructurada

`--model` se pasa literalmente a Cursor, por ejemplo:

```bash
npx pandi-ultracode-cursor run hello \
  --model gemini-3.5-flash --trust-workspace
```

Los aliases portables (`haiku`, `sonnet`, `opus`) no se adivinan. Para mapearlos de forma explícita, configurá
`PANDI_CURSOR_TIER_MODELS`:

```bash
export PANDI_CURSOR_TIER_MODELS='{"haiku":"gemini-3.5-flash","sonnet":"sonnet-4-thinking"}'
```

`effort` se registra como intención, pero Cursor CLI actual solo lo expone dentro de identificadores de modelo
parametrizados; el runner no afirma que lo haya impuesto. Cuando un nodo tiene `schema`, pide JSON, extrae la respuesta
del evento terminal `stream-json`, valida con JSON Schema y reintenta una vez por defecto. Si sigue inválida, falla;
`schemaOnInvalid: "null"` hace que devuelva `null`.

## Artifacts y recuperación

Cada run guarda una fuente e input congelados, stdout/stderr por agente, `events.jsonl`, `journal.json`, `status.json`,
`result.json` y `summary.md`:

```text
.cursor/ultracode/runs/<run-id>/
├── agents/0001-<label>.md
├── events.jsonl
├── journal.json
├── result.json
├── status.json
├── workflow-source.js
└── workflow-transformed.cjs
```

`resume` usa esa fuente e input congelados y solo reutiliza llamadas con cache habilitada. Los efectos de nodos que usan
`cache: false`, `bash()`, escrituras o workers que seguían en vuelo al cortar un proceso pueden repetirse; diseñalos
para ser idempotentes.

Agregá los artifacts efímeros al `.gitignore` del proyecto:

```gitignore
.cursor/ultracode/runs/
```

## Referencia CLI

```text
pandi-ultracode-cursor list [--cwd <dir>]
pandi-ultracode-cursor check <workflow> [--cwd <dir>]
pandi-ultracode-cursor run <workflow> [flags]
pandi-ultracode-cursor resume <run-dir> [flags]
pandi-ultracode-cursor view <run-dir>
pandi-ultracode-cursor doctor [--cursor-command <path>]
```

Corré `pandi-ultracode-cursor --help` para la referencia completa de flags. `/ultracode` es una entrada de chat para el
runner; la inspección y recuperación detalladas siguen en la terminal mediante `view` y `resume`.

## Smoke real opt-in

La suite usa un ejecutable falso por defecto. Una persona autenticada puede verificar el adaptador contra Cursor CLI sin
tocar un proyecto real:

```bash
PANDI_CURSOR_SMOKE=1 node --test \
  extensions/pandi-ultracode-cursor/tests/integration/cursor-live-smoke.test.mjs
```
