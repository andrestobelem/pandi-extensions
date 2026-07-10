# @pandi-coding-agent/pandi-ultracode-codex

Ejecutá workflows portables de Ultracode mediante Codex CLI, sin instalar ni
iniciar Pi. El runner conserva artifacts y journal bajo `.codex/ultracode/runs/`
y usa `codex exec` para cada llamada a `agent()`.

Esta primera entrega es un **host de terminal**. No modifica `~/.codex` ni
instala un plugin de Codex: la CLI actual expone plugins desde marketplaces, no
una carga local por directorio equivalente a los hosts de Claude Code y Cursor.

## Inicio rápido

Necesitás Node 22+ y Codex CLI autenticado:

```bash
npm install -D @pandi-coding-agent/pandi-ultracode-codex
npx pandi-ultracode-codex doctor
npx pandi-ultracode-codex list
```

El runner requiere una decisión explícita sobre el workspace antes de ejecutar
Codex de forma no interactiva:

```bash
npx pandi-ultracode-codex run codex-ultracode \
  --input '{"request":"Auditá el README"}' \
  --concurrency 4 --max-agents 8 --trust-workspace
```

## Workflows y recuperación

El runner busca workflows en este orden:

| Fuente | Ubicación |
| --- | --- |
| Proyecto | `.codex/ultracode/workflows/<name>.js` |
| Host | `workflows/` del paquete |
| Catálogo portable | `pandi-dynamic-workflows/scaffolds/` |

Los workflows usan el formato portable: sin `import`, `export const meta`
opcional y un `return` final. El gateway `codex-ultracode` comienza por Contract
Gate, responde con una sola llamada cuando alcanza y abre fan-out solo para una
tarea que lo justifique.

```bash
npx pandi-ultracode-codex check contract-gate
npx pandi-ultracode-codex view .codex/ultracode/runs/<run-id>
npx pandi-ultracode-codex resume .codex/ultracode/runs/<run-id> --trust-workspace
```

Cada corrida guarda fuente/input congelados, `events.jsonl`, `journal.json`,
`status.json`, `result.json`, `summary.md`, último mensaje y stdout/stderr por
worker. `resume` reutiliza únicamente llamadas cacheadas: los workflows deben
seguir siendo idempotentes.

## Seguridad

Cada worker se ejecuta sin shell con:

```text
codex exec --cd <workspace> --sandbox read-only --json --ephemeral --ignore-user-config
```

El host no pasa `--add-dir`, `--search`, `workspace-write`,
`--dangerously-bypass-*` ni overrides de aprobación. Rechaza escrituras de
agentes, `bash()`, `writeFile()`, `appendFile()` y grants por agente de tools,
skills, extensions, environment o provider.

`read-only` limita los comandos que Codex genera; no convierte el workflow
confiado ni el proceso de Codex en una frontera completa de aislamiento. Para
una garantía fuerte, usá un contenedor, una cuenta o un entorno aislado.

Agregá los artifacts efímeros al proyecto:

```gitignore
.codex/ultracode/runs/
```

## Referencia CLI

```text
pandi-ultracode-codex list [--cwd <dir>]
pandi-ultracode-codex check <workflow> [--cwd <dir>]
pandi-ultracode-codex run <workflow> [flags]
pandi-ultracode-codex resume <run-dir> [flags]
pandi-ultracode-codex view <run-dir>
pandi-ultracode-codex doctor [--codex-command <path>]
```

## Smoke real opt-in

Los tests usan un ejecutable falso. Una persona autenticada puede probar un
worker read-only en un worktree separado:

```bash
PANDI_CODEX_SMOKE=1 node --test \
  extensions/pandi-ultracode-codex/tests/integration/codex-live-smoke.test.mjs
```
