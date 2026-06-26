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
