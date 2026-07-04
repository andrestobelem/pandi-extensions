# Dynamic-workflow primitives (injected globals)

A dynamic-workflow script is a plain JS function that calls a set of pre-injected globals — no `import`/`require`, no `ctx.*`. This page is the index: what each global does, when to reach for it, and where its full doc lives.

## Quickstart

```js
export default async function main() {
  const findings = await agents(files, { concurrency: 8 }); // one subagent per file, 8 at a time
  return compact(findings.filter(Boolean)); // drop nulls (failed items), bound the output size
}
// (or a top-level script that ends in `return`)
```

## Which primitive?

| Need | Reach for |
| --- | --- |
| One subagent call | [`agent`](agent.md) |
| Same step over many items, bounded concurrency | [`agents`](agents.md) |
| Independent branches, wait for all | [`parallel`](parallel.md) |
| Dependent stages per item (no merge across items) | [`pipeline`](pipeline.md) |
| Several attempts, first good one wins | [`race`](race.md) |
| Reuse another workflow as a step | [`workflow`](workflow.md) |

## All globals

| Category | Primitive | What it does |
| --- | --- | --- |
| Subagents & composition | [`agent`](agent.md) | Run one subagent; parsed object with `{ schema }`, else text; `null` on failure. |
| Subagents & composition | [`agents`](agents.md) | Bounded parallel map, one step per item (`{ concurrency, settle }`). |
| Subagents & composition | [`parallel`](parallel.md) | Barrier: run branches, wait for ALL results at once. |
| Subagents & composition | [`pipeline`](pipeline.md) | Dependent stages per item, no cross-item merge; failed items → `null`. |
| Subagents & composition | [`race`](race.md) | First accepted value wins; cancel the in-flight losers. |
| Subagents & composition | [`workflow`](workflow.md) | Compose a reusable sub-workflow inline (depth-bounded). |
| Human & observability | [`ask`](ask.md) | Human-in-the-loop question (input/confirm/select); resume-safe. |
| Human & observability | [`phase`](phase.md) | Mark the current phase for the dashboard/log. |
| Human & observability | [`log`](log.md) | Append a line to the run log. |
| Filesystem & shell | [`bash`](bash.md) | Run a shell command; caching is opt-in (`{ cache: true }`). |
| Filesystem & shell | [`readFile`](readFile.md) | Read a file relative to `cwd`. |
| Filesystem & shell | [`writeFile`](writeFile.md) | Write a file (creates parent dirs). |
| Filesystem & shell | [`appendFile`](appendFile.md) | Append to a file (creates parent dirs). |
| Filesystem & shell | [`listFiles`](listFiles.md) | Recursively list files (skips `node_modules`/`.git`). |
| Artifacts | [`writeArtifact`](writeArtifact.md) | Write a named run artifact. |
| Artifacts | [`appendArtifact`](appendArtifact.md) | Append to a named artifact (concurrency-safe). |
| Utilities | [`sleep`](sleep.md) | Abortable delay. |
| Utilities | [`json`](json.md) | Bounded, safe stringify. |
| Utilities | [`compact`](compact.md) | Bounded stringify for prompts. |
| Utilities | [`args`](args.md) | The workflow input. |
| Read-only run context | [`limits`](limits.md) | `{ concurrency, maxAgents, … }` caps. |
| Read-only run context | [`runId`](runId.md) | This run's id. |
| Read-only run context | [`runDir`](runDir.md) | This run's directory (artifacts live here). |
| Read-only run context | [`cwd`](cwd.md) | The workflow's working directory. |

## How it works

The source of truth for *which* primitives exist is the `sandbox.<name> = …` assignments in `worker-source.ts`. A parity test (`tests/integration/primitives-parity.test.mjs`) keeps this folder 1:1 with that list — add/remove a global there and the test fails until the matching `<name>.md` is added/removed here. This folder is the per-primitive analog of `scaffolds/` for patterns.

## Gotchas

- **Cross-runtime:** only the core (`agent`, `agents`, `parallel`, `pipeline`, `workflow`, `phase`, `log`, `args`, `compact`) is shared with the Claude Code Workflow tool — don't assume the rest exist there.
- **Filesystem/shell** primitives (`bash`, `readFile`, `writeFile`, `appendFile`, `listFiles`) are confined to the run `cwd`.
- **Artifacts** are persisted under `runDir` and stay inspectable after the run ends.
- **Failure shape:** `agent`/`agents` return `null` per failed item instead of throwing — always filter before using results (see the `compact(findings.filter(Boolean))` line above).

## Related

These globals are provided by the `@pandi-coding-agent/pandi-dynamic-workflows` extension — see [`extensions/pandi-dynamic-workflows/README.md`](../README.md) for installation and the full extension surface.
