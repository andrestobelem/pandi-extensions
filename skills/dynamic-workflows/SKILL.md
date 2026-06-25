---
name: dynamic-workflows
description: >-
  Use for Claude Code-style dynamic workflows in Pi: creating or running JavaScript
  orchestration scripts with parallel subagents for complex repo-wide analysis,
  migrations, audits, deep research, adversarial verification, or repeated
  evaluation workflows.
---

# Dynamic Workflows for Pi

Use this skill when a task is too large or valuable for a single linear agent turn and would benefit from orchestration: repo-wide bug hunts, security/performance audits, large migrations/refactors, deep research, adversarial verification, generate-and-filter workflows, tournament/ranking, or loop-until-done checks.

## Core Tool and Commands

Use the `dynamic_workflow` tool. The extension also runs an always-on ultracode router by default: for each substantive task, Pi should evaluate whether a dynamic workflow is warranted and proceed normally for simple tasks. Users can explicitly invoke `/ultracode <task>`, `/deep-research <question>`, or start a message with `ultracode ...` to request this workflow style. Use `/ultracode-mode status|on|off` to inspect or toggle the always-on router for the current session. Visualization commands are available via the `/workflows` TUI dashboard (also `Ctrl+Alt+W`), `/workflow graph <name>`, `/workflow runs`, and `/workflow view [latest|runId]`.

If a run was interrupted (state `stale`, `failed`, or `cancelled`), resume it in place with `dynamic_workflow({ action: "resume", name: "<runId>" })` (or `/workflow resume <runId>`). Completed subagent and bash calls are read from the run journal and are not re-executed, so resuming is cheap. `ctx.agent()` is cached by default (opt out with `{ cache: false }`); `ctx.bash()` is cached only with `{ cache: true }`. Calls whose arguments depend on `Date.now()`/`Math.random()` will not match the cache and will re-run on resume.

Typical loop:

1. `dynamic_workflow({ action: "template" })` to inspect the workflow API.
2. Write a project workflow with `action: "write"`, usually under `scope: "project"`.
3. Run it with `action: "run"` and explicit `input`, `concurrency`, and `maxAgents`.
4. Inspect execution with `dynamic_workflow({ action: "view", name: "latest" })` or read artifacts from the reported run directory.
5. Synthesize the final answer from workflow output and artifacts.

## Workflow Patterns

- **Fan-out and synthesize**: split files/topics among subagents, then run a synthesis subagent.
- **Classify and act**: classify many items, then run targeted follow-ups only on high-signal items.
- **Adversarial verification**: have independent agents critique/verify a plan or patch.
- **Generate and filter**: generate multiple candidates, then evaluate and select.
- **Tournament/ranking**: compare candidates pairwise or by rubric.
- **Loop until done**: repeat detect → fix/verify until no findings or budget exhausted.

## Prompting Patterns

Use prompts that make the orchestration pattern explicit:

- **Independent fan-out prompts**: tell each subagent its perspective must be complete even if others fail.
- **Evidence contracts**: require file/line citations, URLs, commands, or `INSUFFICIENT_EVIDENCE` / `NO_FINDINGS`.
- **Structured output**: ask for fixed sections such as Verdict, Findings, Evidence, Risks, Fixes, and Verification gaps.
- **Synthesis-as-judge**: the final agent should deduplicate, discard unsupported claims, preserve uncertainty, and choose a concrete recommendation instead of averaging opinions.
- **Adversarial review**: give critics an explicit goal to reduce scope, find edge cases, and identify accepted risks.
- **Partial failure handling**: synthesis prompts should mention failed, empty, stale, or timed-out agents instead of hiding them.
- **Safety by default**: for audits, say “do not edit files” and restrict tools to read-only.

## Workflow API Reminders

Workflow files export:

```js
module.exports = async function workflow(ctx, input) {
  await ctx.log("start", { input });
  const result = await ctx.agent("Do a focused task", { tools: ["read", "grep", "find", "ls"] });
  await ctx.writeArtifact("result.json", result);
  return result.output;
};
```

Useful helpers:

- `ctx.agent(prompt, options)` — run one Pi subagent.
- `ctx.agents(items, { concurrency })` — run many subagents with bounded concurrency.
- `ctx.bash(command)` — run shell commands.
- `ctx.readFile`, `ctx.writeFile`, `ctx.appendFile`, `ctx.listFiles` — file helpers confined to the workflow cwd.
- `ctx.writeArtifact(name, data)` — persist intermediate state in the run directory.
- `ctx.compact(value, maxChars)` — JSON/stringify and truncate large results.
- `ctx.limits` — read-only effective limits; clamp workflow concurrency to `ctx.limits.concurrency`.

## Safety and Cost

- Do not use workflows for simple tasks.
- Workflows are trusted JavaScript and can spawn many model calls.
- Keep `maxAgents` and `concurrency` explicit.
- For audits/research, restrict subagents to read-only tools: `tools: ["read", "grep", "find", "ls"]`.
- Avoid `bash` unless the workflow genuinely needs shell/web access.
- Keep subagent prompts narrow and require line/file citations when relevant.
- Prefer explicit prompt contracts over vague requests: role, evidence rules, output format, confidence, and what to do when blocked.
