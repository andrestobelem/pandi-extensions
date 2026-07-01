# Gondolin micro-VM isolation (opt-in)

Date: 2026-06-30

[Gondolin](https://github.com/earendil-works/gondolin) is pi's local Linux
micro-VM. The `pi-coding-agent` package ships it as an **example extension**
(`<pi>/examples/extensions/gondolin/`) that routes pi's built-in tools and `!`
commands into the VM.

It is **not part of this repo's published package**. We keep it opt-in because
it requires a heavy, platform-specific native dependency (`@earendil-works/gondolin`)
that would bloat the lockfile and only runs on a couple of platforms.

## What it isolates (and what it does not)

- **Isolated:** the built-in `read`, `write`, `edit`, `bash`, `grep`, `find`,
  `ls` tools and user `!` commands run inside the VM. Your host cwd is mounted at
  `/workspace`; writes under `/workspace` pass through to the host.
- **NOT isolated:** dynamic-workflow **subagents** spawn child `pi`/`codex`
  processes on the **host** (extensions run where `pi` runs). So Gondolin does not
  hide the `node → pi/codex → /bin/bash` process lineage. For full isolation
  of the whole orchestrator, run all of `pi` inside Docker instead (see pi's
  `docs/containerization.md`).

## Requirements

- Node.js `>= 23.6.0`.
- Platform with a prebuilt runner: **`darwin-arm64`** or **`linux-x64`** only.
- QEMU available (e.g. `brew install qemu` on macOS).

## Install

```bash
npm run setup:gondolin
```

This copies pi's shipped example into this repo's project-local
`.pi/tools/gondolin` and runs `npm install --ignore-scripts` there. We
deliberately install into `.pi/tools/` (NOT `.pi/extensions/`, which is
auto-discovered and would boot a micro-VM on **every** pi session in this repo).
`.pi/tools/` is gitignored, so the heavy platform-specific native deps stay out
of version control.

The `--ignore-scripts` install is the upstream-recommended, script-free path: the
krun runner is a prebuilt binary and `ssh2` falls back to pure JS without the
optional `cpu-features` native build.

## Use

From this repo's root:

```bash
pi -e .pi/tools/gondolin
```

A convenient shell alias:

```bash
alias pi-vm='pi -e .pi/tools/gondolin'
```

## Verify

Inside the pi session:

- `/gondolin` — shows VM id, host workspace, guest workspace, shell.
- `!uname -a` — must report **Linux** (not Darwin).
- `!ls -la /workspace` — must show your host project files.
