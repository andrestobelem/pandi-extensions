# @pandi-coding-agent/pandi-ultracode-claude

Ejecutá workflows portables de Ultracode mediante Claude Code CLI, sin iniciar Pi ni depender de la herramienta
`Workflow` nativa. El paquete ofrece una CLI observable y un plugin local con `/ultracode-run`; cada corrida conserva
artifacts y journal en `.claude/ultracode/runs/`.

Este runner es **trusted-workspace only**: ejecutá únicamente workflows y workspaces que hayas revisado y decidido
confiar. `run` y `resume` rechazan la ejecución salvo que pases `--trust-workspace` de forma explícita.

`/ultracode` sigue siendo la entrada nativa existente de Claude Code. Elegí `/ultracode-run` cuando necesitás un proceso
externo, artifacts inspeccionables y recuperación mediante `resume`.

## Inicio rápido

Necesitás Node 22+ y Claude Code CLI autenticado:

```bash
npm install -D @pandi-coding-agent/pandi-ultracode-claude
npx pandi-ultracode-claude doctor
npx pandi-ultracode-claude list
```

La ejecución no interactiva de Claude omite su diálogo de confianza. Por eso cada `run` y `resume` exige el acuse
explícito `--trust-workspace`:

```bash
npx pandi-ultracode-claude run claude-ultracode \
  --input '{"request":"Auditá el README"}' \
  --concurrency 4 --max-agents 8 --trust-workspace
```

## Usarlo desde Claude Code

Cargá el plugin solo para la sesión actual; el paquete no escribe en `~/.claude`:

```bash
claude --plugin-dir "$(node -p \"require('node:path').dirname(require.resolve('@pandi-coding-agent/pandi-ultracode-claude/package.json'))\")/claude-plugin"
```

En esa sesión, usá `/ultracode-run <tarea>`. El comando pedirá confirmar la confianza del workspace antes de lanzar el
runner. No confundirlo con `/ultracode`, que preserva el runtime `Workflow` nativo.

## Workflows y recuperación

El runner busca workflows en este orden:

| Fuente            | Ubicación                               |
| ----------------- | --------------------------------------- |
| Proyecto          | `.claude/ultracode/workflows/<name>.js` |
| Host              | `workflows/` del paquete                |
| Catálogo portable | `pandi-dynamic-workflows/scaffolds/`    |

Los workflows externos usan el formato portable: sin `import`, `export const meta` opcional y un `return` final. No
cargan `.claude/workflows/`: ese catálogo es un artifact del runtime `Workflow` nativo y no comparte este contrato.

```bash
npx pandi-ultracode-claude check contract-gate
npx pandi-ultracode-claude view .claude/ultracode/runs/<run-id>
npx pandi-ultracode-claude resume .claude/ultracode/runs/<run-id> --trust-workspace
```

Cada corrida congela fuente e input y guarda `events.jsonl`, `journal.json`, `status.json`, `result.json`, `summary.md`
y stdout/stderr por worker. `resume` reutiliza solo las llamadas cacheadas; diseñá los workflows como idempotentes.

## Seguridad

Los workers se lanzan sin shell mediante `claude --print` con `--permission-mode plan`, allowlist `Read,Glob,Grep` y
`--safe-mode`. Esta primera entrega rechaza escrituras de agentes, `bash()`, `writeFile()`, `appendFile()` y grants por
agente de tools, skills, extensions, environment o provider. Tampoco agrega directorios, plugins, MCP ni flags
`dangerously-*`.

Estos límites reducen el privilegio, pero no convierten workflows confiados ni el proceso de Claude en una frontera de
aislamiento. `node:vm` aporta solamente un contexto de evaluación: el workflow corre dentro del proceso del runner con
las capacidades host inyectadas. No es un sandbox de seguridad y no admite código no confiable.

Una futura frontera de proceso/OS está diseñada, pero no implementada, en
[`docs/research/2026-07-11-ultracode-process-os-boundary.md`](../../docs/research/2026-07-11-ultracode-process-os-boundary.md).

Agregá los artifacts efímeros al proyecto:

```gitignore
.claude/ultracode/runs/
```

## Referencia CLI

```text
pandi-ultracode-claude list [--cwd <dir>]
pandi-ultracode-claude check <workflow> [--cwd <dir>]
pandi-ultracode-claude run <workflow> [flags]
pandi-ultracode-claude resume <run-dir> [flags]
pandi-ultracode-claude view <run-dir>
pandi-ultracode-claude doctor [--claude-command <path>]
```

## Smoke real opt-in

Los tests usan un ejecutable falso. Una persona autenticada puede probar el adaptador en un worktree separado con un
solo worker:

```bash
PANDI_CLAUDE_SMOKE=1 node --test \
  extensions/pandi-ultracode-claude/tests/integration/claude-live-smoke.test.mjs
```
