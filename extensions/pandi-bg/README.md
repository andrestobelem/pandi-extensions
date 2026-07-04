# @pandi-coding-agent/pandi-bg

`/bg` runs a shell command in the background from inside a Pi session, so a long build, test suite, or server doesn't block your chat. Each job gets its own log files and a status you can poll later. It's the small, human-only sibling of `dynamic_workflow` background runs — in-memory and **not** resumable; reach for `dynamic_workflow` when you need agentic orchestration that survives a restart.

## Try it

```bash
/bg start npm test
# Started background job bg-lz3k2p1-a1b2c3d4.
# Artifacts: /path/to/artifacts/bg-lz3k2p1-a1b2c3d4
# Status: /bg status bg-lz3k2p1-a1b2c3d4
# Logs: /bg logs bg-lz3k2p1-a1b2c3d4

/bg status bg-lz3k2p1-a1b2c3d4
/bg logs bg-lz3k2p1-a1b2c3d4
```

## Install

From npm:

```bash
pi install npm:@pandi-coding-agent/pandi-bg
```

From this repository:

```bash
pi install ./extensions/pandi-bg          # global (your user)
pi install -l ./extensions/pandi-bg       # project-local
pi --no-extensions -e ./extensions/pandi-bg   # one-off trial, nothing else loaded
```

## What you get

- Human-only slash commands to start, inspect, cancel, and clean up local background jobs. No `background_job` LLM tool is registered.
- Per-job artifacts under `.pi/bg/runs/<jobId>/`: `job.json`, `status.json`, `events.jsonl`, `stdout.log`, `stderr.log`, `combined.log`.
- A bounded lifecycle journal (`/bg events`) that explains *why* a job ended `failed`/`cancelled`/`interrupted` — evidence `status.json` alone does not carry.
- Safe disk cleanup (`/bg delete`, `/bg prune`) that only ever removes finished jobs and records an audit line.

## Commands

| Command | What it does |
| --- | --- |
| `/bg preview <command>` | Preview a background job without running it (deprecated alias: `/bg plan`). |
| `/bg start <command>` | Start a background job in a trusted project. |
| `/bg list` | List known jobs. |
| `/bg status <jobId>` | Inspect one job, including a liveness/identity probe. |
| `/bg logs <jobId>` | Read bounded, truncated logs. |
| `/bg events <jobId>` | Read the bounded lifecycle journal (`events.jsonl`). |
| `/bg cancel <jobId>` | Cancel a job owned by this Pi process (or a verified orphan). |
| `/bg delete <jobId>` | Delete one finished job's artifacts. |
| `/bg prune [--yes]` | Preview deletable finished jobs (dry-run); `--yes` removes them. |

## How it works

- `/bg start` only works in persistent TUI/RPC sessions and trusted projects; untrusted projects are refused before anything executes or is written.
- Mutating commands (`start`, `cancel`, `delete`, `prune`) are blocked while `/plan` is active.
- Jobs run as detached process groups, except on Windows, where the child is not spawned detached. `job.json` and `status.json` are written with temp file + atomic rename; logs are append-only.
- Project-local artifacts live in `.pi/bg/runs/<jobId>/`. A global read-only fallback exists at `~/.pi/agent/bg/runs/<cwd-hash>/<jobId>/`.
- There is no Supacode runner, daemon, automatic rehydration, or `/bg` dashboard.

## Limitations & safety notes

- **Plaintext artifacts.** The command (`job.json`) and its output logs are stored unredacted. Avoid passing secrets on the command line; reclaim space with `/bg prune` or `/bg delete`.
- **The trust gate protects context and artifacts, not the command.** Like the rest of Pi's exec, `/bg start` runs whatever you type via `shell:true`.
- **Jobs do not survive a Pi restart.** They are tracked in memory by the Pi process that started them; `/bg cancel` refuses jobs not active in the current session (except verified orphans, below).
- A still-running detached job is left orphaned after a restart. Stop a **verified** orphan with `/bg cancel`; otherwise use OS tools (`kill`/`pkill`/`taskkill`).
- Deletion is finished-jobs-only: live state is re-derived at prune time, so a running, session-active, or identity-verified-alive job is never deleted. Cleanup acts on the project-local store only, is symlink/path safe (an inner symlink is unlinked, not followed), and appends one `.pi/bg/runs/.audit.jsonl` line per removal.

## Details

### Liveness and pid reuse

- For jobs not owned by the current session, `/bg status` and `/bg list` project the state at read time by probing the recorded pid (signal-0, no signal sent): `orphaned` (pid alive), `interrupted` (pid dead), or `stale` (no pid to probe).
- To defeat pid reuse, each job records a process **start identity** (`startId`: Linux `/proc` starttime; macOS/BSD `ps -o lstart=`; absent on Windows).
- `/bg status` does one identity probe: a live pid with a matching identity is a verified `orphaned` (`identity: verified`); a live pid with a different identity means the pid was reused and is reported as `interrupted` (`interruptedCause: pid-reused`); unreadable identity stays a best-effort `orphaned` with a verify-before-kill hint.
- `/bg list` keeps only the cheap signal-0 probe (no per-job subprocess), so it may show a best-effort `orphaned` that `/bg status` would refine.

### Cancel semantics

- `/bg cancel` always acts on jobs owned by the current Pi process.
- For a job persisted by another session, it signals the process group **only** when the recorded start identity proves the live pid is still that job's process: it sends `SIGTERM` to the group and rewrites the job to `cancelled` (reason `cancel-verified-orphan`).
- A reused pid, or one whose identity cannot be read, is refused and never signaled — stop it with OS tools.

### Session-start self-heal

- On session start (persistent, trusted sessions only), a project-local job persisted as `running`/`starting` is atomically rewritten to a terminal `interrupted` on disk when its pid is dead **or** alive-but-reused (different start identity).
- Terminalizing only on positive evidence (dead pid or proven reuse) keeps the rewrite safe; verified-alive or unprobeable jobs are left untouched (still projected as `orphaned`/`stale`).

## Related

For the full bundle of extensions and skills, install the repository root instead.
