# @pandi-coding-agent/container

Manage [Apple `container`](https://github.com/apple/container) sandboxes — Linux
environments running in lightweight **micro-VMs** (Virtualization.framework) — from
inside a Pi session. Two surfaces:

- **`/container`** — human slash command (interactive, confirms destructive ops).
- **`container_sandbox`** — a model-callable tool so Pi can run **isolated Linux
  commands** in a micro-VM instead of running them directly on the host.

Both share the same pure helpers, and `container` is always spawned with an **argv
array (never a shell string)**, so image refs, machine names, and commands cannot
inject shell.

## Requirements

Apple `container` runs Linux in per-environment VMs and requires:

- **macOS on Apple Silicon** (arm64); macOS 26 recommended.
- the CLI: `brew install container`
- a configured kernel: `container system kernel set --recommended`
- a booted subsystem: `container system start`

On an unsupported host the extension returns a single bounded message instead of
failing obscurely.

## Command

```text
/container [status]                     subsystem + machine overview
/container list                         list container machines
/container create <image> [name]        create a machine (e.g. alpine:latest dev)
/container run <machine> -- <cmd...>    run a command inside a machine
/container stop [name]                  stop a machine (default if omitted)
/container remove <name>                delete a machine (confirms first)
```

- `run` takes the command after a `--` separator, e.g.
  `/container run dev -- uname -a`. The command is passed as an **argv array**.
- `remove` asks for confirmation in a TUI before deleting.

## Tool

The `container_sandbox` tool takes an `action`
(`status` | `list` | `create` | `run` | `stop` | `remove`) plus:

- `name` — machine name (create/stop/remove, or run target)
- `image` — OCI image (create, or ephemeral run), e.g. `alpine:latest`
- `command` — **argv array** for `run` (e.g. `["uname","-a"]`)
- `machine` — existing machine to run inside (else ephemeral via `image`)
- `workdir`, `cpus`, `memory`, `homeMount` (`ro`/`rw`/`none`), `setDefault`
- `force` — required for `remove`

It returns a text summary plus structured `details` (the parsed machine list, the
created name, the run target/exit code, etc.). It **never deletes by default**:
`remove` only proceeds when `force: true` is passed explicitly.

### Isolated command execution

```jsonc
// run inside an existing persistent machine
{ "action": "run", "machine": "dev", "command": ["uname", "-sr"] }

// run in a fresh ephemeral container (removed after it exits)
{ "action": "run", "image": "alpine:latest", "command": ["echo", "hello"] }
```

A persistent **machine** mirrors your macOS home/cwd into Linux (edit on macOS,
run in Linux); an **ephemeral** container is a one-shot `container run --rm`.

## Install

```sh
pi install ./extensions/pi-container
# or, to try without installing:
pi --no-extensions -e ./extensions/pi-container
```
