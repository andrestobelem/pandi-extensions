# Research: ultracode always-on

Date: 2026-06-25

## Request

The user asked Pi to evaluate each task by default and decide whether it should be solved through a dynamic workflow, inspired by Claude Code's `ultracode` mode, and to keep it always active.

## Findings about Claude Code

According to public Claude Code and Anthropic documentation:

- Dynamic workflows are JavaScript scripts that Claude writes/runs to orchestrate subagents in parallel.
- They are used for large audits, migrations, deep research, cross-checking, and tasks with independent branches.
- They can be triggered by requesting a workflow or using the word `ultracode`.
- The `/effort ultracode` mode makes Claude Code automatically decide whether a substantive task should be turned into dynamic workflows.
- `ultracode` combines high reasoning (`xhigh`) with automatic workflow orchestration—it is not just a model effort level.
- Workflows can have potentially high cost, so the documentation recommends explicit limits, workflow review, and conscious use.

### Sources consulted

- Claude Code Docs — Dynamic workflows: https://code.claude.com/docs/en/workflows
- Claude Code Docs — Model configuration / effort ultracode: https://code.claude.com/docs/en/model-config
- Anthropic Blog — Introducing dynamic workflows in Claude Code: https://claude.com/blog/introducing-dynamic-workflows-in-claude-code
- Claude Code Docs — Subagents: https://code.claude.com/docs/en/sub-agents
- Claude Code Settings: https://docs.anthropic.com/en/docs/claude-code/settings

## Implementation decision for Pi

We implemented an always-on router in the `pandi-dynamic-workflows` extension:

- A short system prompt section is injected in `before_agent_start`.
- The extension tries to enable the `dynamic_workflow` tool so the router is available.
- The router asks Pi to silently evaluate each substantive task before deciding on an approach.
- For simple tasks, Pi should proceed normally.
- For potentially broad tasks, Pi should run a cheap inline scout before orchestrating.
- Pi should create/reuse/run workflows only when there is a clear reason: completeness, confidence, or scale, with explicit limits.
- For long-running work, it should prefer background (`start`) and then inspect with `runs/view`.

## Modified files

- `extensions/dynamic-workflows.ts`
- `README.md`
- `.pi/skills/dynamic-workflows/SKILL.md`
- `docs/README.md`
- `docs/memoria.md`
- `docs/conversaciones/2026-06-25-revisar-estado-actual.md`

## New commands

```text
/ultracode-mode status
/ultracode-mode off
/ultracode-mode on
```

## Validations performed

### Extension initialization without model prompt

We verified that Pi can explicitly initialize the extension without sending a prompt to the model:

```bash
pi --no-extensions -e ./extensions/dynamic-workflows.ts --list-models __no_such_model__
```

Result: exit code `0`.

### Command registration in print mode

We verified that the new command is registered and responds in print mode:

```bash
pi --no-extensions -e ./extensions/dynamic-workflows.ts --no-session -p "/ultracode-mode status"
```

Result:

```text
Ultracode always-on is enabled.
```

### Validation limitation

The repo does not have TypeScript installed or `typecheck` scripts; `npx tsc` was not available.

## Scope note

This implementation replicates the automatic routing behavior. For now, it does not force the thinking level to `xhigh` to avoid unexpectedly changing cost/model behavior; the main requested criterion was to decide by default whether to use a workflow.
