# @pandi-coding-agent/container

Manage [Apple `container`](https://github.com/apple/container) sandboxes — Linux environments running in lightweight micro-VMs — from inside a Pi session. Pi can run isolated Linux commands in a micro-VM instead of running them directly on the host.

## What you get

- `/container` — human slash command; interactive and it confirms destructive operations.
- `container_sandbox` — model-callable tool with explicit actions and no surprise deletes.
- Shell-injection safety: `container` is always spawned with an argv array, never a shell string, so image refs, machine names, and commands cannot inject shell.

## Install

From npm:

```bash
pi install npm:@pandi-coding-agent/container
```

From this repository:

```bash
pi install ./extensions/pi-container          # global (your user)
pi install -l ./extensions/pi-container       # project-local
pi --no-extensions -e ./extensions/pi-container   # one-off trial, nothing else loaded
```

## Commands

| Command | What it does |
| --- | --- |
| `/container` | Bare invocation opens an interactive action selector (falls back to `status` off-TUI). |
| `/container status` | Show subsystem + machine overview. |
| `/container list` | List container machines. |
| `/container create <image> [name] [--size <tier>]` | Create a machine (e.g. `alpine:latest dev --size small`). |
| `/container run <machine> -- <cmd...>` | Run a command inside a machine, e.g. `/container run dev -- uname -a`. |
| `/container stop [name]` | Stop a machine (the default machine if omitted). |
| `/container remove <name>` | Delete a machine; asks for confirmation in a TUI first. |
| `container_sandbox` | Model tool: same actions (`status`, `list`, `create`, `run`, `stop`, `remove`) — see below. |

## How it works

The `container_sandbox` tool takes an `action` plus:

| Parameter | Meaning |
| --- | --- |
| `name` | Machine name (create/stop/remove, or run target). |
| `image` | OCI image (create, or ephemeral run), e.g. `alpine:latest`. |
| `command` | Argv array for `run`, e.g. `["uname","-a"]`. |
| `machine` | Existing machine to run inside (else ephemeral via `image`). |
| `tier` | Named size preset for `create` or ephemeral `run` — see [Size tiers](#size-tiers). |
| `workdir`, `cpus`, `memory`, `homeMount` (`ro`\|`rw`\|`none`), `setDefault` | Run/create tuning. Explicit `cpus`/`memory` override `tier`. |
| `force` | Required for `remove`. |

It returns a text summary plus structured `details` (the parsed machine list, the created name, the run target/exit code, etc.).

Two run modes:

```jsonc
// run inside an existing persistent machine
{ "action": "run", "machine": "dev", "command": ["uname", "-sr"] }

// run in a fresh ephemeral container (removed after it exits)
{ "action": "run", "image": "alpine:latest", "command": ["echo", "hello"] }
```

A persistent machine mirrors your macOS home/cwd into Linux (edit on macOS, run in Linux); an ephemeral container is a one-shot `container run --rm`.

## Size tiers

Apple `container` v1.0.0 defaults `machine create --memory` to **half of the host's RAM** (e.g. ~18G on a 36GB machine) and leaves the `--cpus` default undocumented (`container machine create --help`); ephemeral `run`'s `-c`/`-m` defaults are likewise undocumented. Half the host RAM is a lot for a sandbox, so the extension ships named presets:

| Tier | CPUs | Memory | Valid for |
| --- | --- | --- | --- |
| `micro` | 1 | 256M | ephemeral `run` only |
| `tiny` | 2 | 512M | ephemeral `run` only |
| `small` | 2 | 1G | `create` + ephemeral `run` |
| `medium` | 4 | 2G | `create` + ephemeral `run` |
| `large` | 8 | 4G | `create` + ephemeral `run` |

The ladder is rebased on a 256M `micro`, doubling memory per tier. Apple's virtualization stack enforces a hard **200 MiB minimum** per VM (`minimum memory amount allowed is 200 MiB`); a real `npm i -g @earendil-works/pi-coding-agent` + `pi --version` was verified inside a 200M VM at ~114MB RSS, so 256M comfortably runs small Node/CLI workloads.

- **Opt-in**: with no `tier` and no explicit `cpus`/`memory`, no flags are emitted and the CLI keeps its own defaults (identical behavior to before tiers existed).
- **Precedence**: explicit `cpus`/`memory` override the tier, field by field.
- **Scope**: tiers apply to `create` (machine) and to ephemeral image `run`s only. They do **not** apply to `run` inside an existing machine — its resources are fixed at creation by the upstream CLI.
- **Two different CLI floors** (both measured on v1.0.0): ephemeral `run` bottoms out at **200 MiB**, but `machine create` requires **at least 1G** (real error: `invalid memory value '256mb'. Must be greater than 1gb`). The extension refuses `micro`/`tiny` for `create` with a bounded error before spawning anything.

```jsonc
// tool: create a small machine
{ "action": "create", "image": "alpine:latest", "name": "dev", "tier": "small" }

// tool: ephemeral run with a tier (emits --cpus 2 --memory 1G)
{ "action": "run", "image": "alpine:latest", "tier": "small", "command": ["uname", "-a"] }
```

Command equivalent: `/container create alpine:latest dev --size small` (alias `--tier`).

## Limitations & safety notes

- Apple `container` requires **macOS on Apple Silicon** (arm64); macOS 26 recommended. On an unsupported host the extension returns a single bounded message instead of failing obscurely.
- Setup needed before use: the CLI (`brew install container`), a configured kernel (`container system kernel set --recommended`), and a booted subsystem (`container system start`).
- The tool never deletes by default: `remove` only proceeds when `force: true` is passed explicitly. The `/container remove` command confirms in a TUI first.
- Commands run inside the VM are passed as an argv array — no shell interpolation on the host.

## Related

For the full bundle of extensions and skills, install the repository root instead.
