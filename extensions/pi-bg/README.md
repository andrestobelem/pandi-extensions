# pi-dynamic-workflows-bg

Individual Pi package for the `/bg` local background jobs extension.

## Install

From this repository:

```bash
pi install ./extensions/pi-bg
pi install -l ./extensions/pi-bg
pi --no-extensions -e ./extensions/pi-bg
```

## Provides

- `/bg plan <command>` — preview a background job.
- `/bg start <command>` — start a trusted project-local background job.
- `/bg list` — list known jobs.
- `/bg status <jobId>` — inspect a job.
- `/bg logs <jobId>` — read bounded logs.
- `/bg cancel <jobId>` — cancel an active job from the current Pi process.

Artifacts are written under `.pi/bg/runs/` for trusted projects. For the full bundle of extensions and skills, install the repository root instead.

## Limitations

- Jobs are tracked in memory by the Pi process that started them. They do not
  survive a restart: after Pi exits or crashes, a previously `running` job is
  reported as `stale` and cannot be cancelled with `/bg cancel` (it refuses any
  job not active in the current session).
- Started jobs are detached process groups, so a still-running detached job is
  left orphaned after a restart and must be stopped with OS tools (for example
  `kill`/`pkill` or `taskkill`).
- `/bg cancel` only acts on jobs owned by the current Pi process; it never
  signals a job persisted by another session or a previous run.
