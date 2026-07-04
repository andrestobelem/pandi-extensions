# @pandi-coding-agent/typescript-lsp

TypeScript diagnostics feedback for Pi: after a turn that wrote or edited TypeScript, it runs `tsc --noEmit` on the relevant project(s) and reports errors only for the files that turn actually touched.

## What you get

- Automatic, non-blocking feedback on `agent_end` — advisory by default, opt-in autofix.
- `typescript_diagnostics` — a model tool for on-demand checks.
- `/tsc` — a slash command to control and run checks yourself.

## Install

From npm:

```bash
pi install npm:@pandi-coding-agent/typescript-lsp
```

From this repository:

```bash
pi install ./extensions/pi-typescript-lsp          # global (your user)
pi install -l ./extensions/pi-typescript-lsp       # project-local
pi --no-extensions -e ./extensions/pi-typescript-lsp   # one-off trial, nothing else loaded
```

## Commands

| Command | What it does |
| --- | --- |
| `/tsc` or `/tsc status` | Show enabled state, mode, scope, autofix, and max. |
| `/tsc on` / `/tsc off` | Enable or disable automatic feedback. |
| `/tsc run` | Run a check now and report the result. |
| `/tsc scope touched\|project` | Set the default scope (touched files vs. whole project). |
| `/tsc autofix on\|off` | Switch between advisory and autofix delivery. |
| `/tsc max <n>` | Cap how many diagnostics are surfaced. |
| `typescript_diagnostics` | Model tool: run diagnostics with optional `scope` (`touched` default, or `project` for `<cwd>/tsconfig.json`); returns a text summary plus structured `details`. |

## How it works

- Diagnostics fire on `agent_end` — after the whole turn finishes — not after every write. Mid-turn a file is often half-edited and would report transient errors; checking once at the edge, scoped to touched files, gives honest signal with minimal noise.
- **advisory** (default): if touched files have type errors, the report arrives as a non-blocking message on the next turn. Identical reports are de-duplicated so the same errors are not re-injected turn after turn.
- **autofix** (opt-in): the report triggers a follow-up turn so the agent fixes the errors immediately. A per-prompt budget (default 1 auto-triggered fix) plus the same de-duplication means it can never loop.

## Limitations & safety notes

- **Not a full LSP.** Despite the name, this is diagnostics only — no hover, no go-to-definition, no completions. Think "did my TypeScript edits still compile?".
- **Non-blocking by design.** It never blocks a tool call; a missing tsconfig or tsc makes it a quiet NO-OP with one advisory warning, never a broken session.
- `tsc` is always spawned with an argv array — never a shell string — so paths cannot inject shell commands.
- A run that exceeds the timeout budget is surfaced as inconclusive ("timed out"), never as a clean check, and does not disturb the advisory dedupe state.

## Details

`tsc` resolution order:

1. `PI_TS_LSP_TSC` — absolute path to a `tsc.js`, executed with the current `node`.
2. The nearest `node_modules/typescript/bin/tsc`, walking up from the tsconfig directory.
3. Fallback: `npx tsc`.

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_TS_LSP` | `on` | `on` / `off` — enable the extension |
| `PI_TS_LSP_MODE` | `advisory` | `advisory` / `autofix` |
| `PI_TS_LSP_MAX` | `20` | Max diagnostics surfaced (positive int) |
| `PI_TS_LSP_AUTOFIX` | `off` | `on` / `off` — opt into autofix turns |
| `PI_TS_LSP_TSC` | (auto) | Absolute path to a `tsc.js` to run |
| `PI_TS_LSP_TIMEOUT_MS` | `60000` | Wall budget per `tsc` run (positive int, ms) |

## Related

For the full bundle of extensions and skills, install the repository root instead.
