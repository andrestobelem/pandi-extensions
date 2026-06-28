# pi-typescript-lsp

TypeScript **diagnostics feedback** from inside a Pi session. After the agent
finishes a turn that wrote or edited TypeScript, this extension runs
`tsc --noEmit` on the relevant project(s), keeps only the **files the turn
actually touched**, and surfaces a bounded top-N report.

> **Not a full LSP.** The package name says "lsp", but the real contract is
> diagnostics only — there is **no hover, no go-to-definition, no completions**.
> Think of it as "did my TypeScript edits still compile?" feedback.

## Why the coherent edge?

Diagnostics fire on **`agent_end`** — the coherent edge, after the whole turn
finishes — not after every individual write/edit. Mid-turn a file is often
half-edited and would report transient, misleading errors. Checking once at the
edge, scoped to touched files, gives honest signal with minimal noise. It is
**non-blocking**: a tool call is never blocked, and a missing tsconfig/tsc is a
quiet NO-OP (one advisory warning), never a broken session.

## Surfaces

- **Automatic feedback** on `agent_end` (advisory by default).
- **`typescript_diagnostics`** — a model-callable tool (pull / on-demand).
- **`/tsc`** — a human slash command.

`tsc` is always spawned with an **argv array (never a shell string)**, exactly as
`pi-worktree` spawns `git`, so paths cannot inject shell commands.

## Feedback modes

- **advisory** (default): if touched files have type errors, the report is sent
  as a non-blocking message delivered on the next turn
  (`sendMessage({ deliverAs: "nextTurn" })`). Identical reports are de-duplicated
  so the same errors are not re-injected turn after turn.
- **autofix** (opt-in): the report is delivered as a follow-up that triggers a
  turn (`deliverAs: "followUp", triggerTurn: true`) so the agent fixes the errors
  immediately. There is a **per-prompt budget** (default 1 auto-triggered fix)
  plus the same de-duplication, so it can never loop. It **never** blocks.

## Tool

`typescript_diagnostics` takes an optional `scope`:

- `touched` (default): only the files edited so far this turn.
- `project`: the whole `<cwd>/tsconfig.json`.

It returns a text summary plus structured `details`
(`{ scope, hasErrors, count, diagnostics }`).

## Command

```text
/tsc                       show status
/tsc status                show status
/tsc on | off              enable / disable automatic feedback
/tsc run                   run a check now and report
/tsc scope touched|project set the default scope
/tsc autofix on|off        switch advisory ↔ autofix
/tsc max <n>               cap how many diagnostics are surfaced
```

## tsc resolution

In order:

1. `PI_TS_LSP_TSC` — absolute path to a `tsc.js`, executed with the current
   `node`.
2. The nearest `node_modules/typescript/bin/tsc`, walking up from the tsconfig
   directory.
3. Fallback: `npx tsc`.

If neither a tsconfig nor a tsc can be found, the extension is a NO-OP with a
single advisory warning.

## Configuration (env)

| Variable          | Meaning                                  | Default    |
| ----------------- | ---------------------------------------- | ---------- |
| `PI_TS_LSP`       | `on` / `off` — enable the extension      | `on`       |
| `PI_TS_LSP_MODE`  | `advisory` / `autofix`                   | `advisory` |
| `PI_TS_LSP_MAX`   | max diagnostics surfaced (positive int)  | `20`       |
| `PI_TS_LSP_AUTOFIX` | `on` / `off` — opt into autofix turns  | `off`      |
| `PI_TS_LSP_TSC`   | absolute path to a `tsc.js` to run       | (auto)     |

## Install

```sh
pi install ./extensions/pi-typescript-lsp
# or, to try without installing:
pi --no-extensions -e ./extensions/pi-typescript-lsp
```
