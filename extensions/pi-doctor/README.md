# pi-doctor

Adds a `/doctor` command that runs the pi-dynamic-workflows **environment check**
(`scripts/doctor.mjs`) from inside a Pi session and shows the report — the same
read-only check as `npm run doctor`, one keystroke away.

## What it does

- Locates `scripts/doctor.mjs` by walking up from the current working directory,
  falling back to a path relative to this extension.
- Spawns it with `node` (an **argv array**, never a shell string) and captures the
  output. `doctor.mjs` self-locates its own repo root and emits plain text when
  piped (no ANSI), so the report shows cleanly.
- Surfaces the report via `notify` — `info` when all mandatory requirements are
  present, `error` when the check exits non-zero (a mandatory requirement is
  missing), and a friendly `warning` when run outside the repo.

## Usage

```text
/doctor
```

## Notes

- It is a **dev convenience for this repo**: `/doctor` only makes sense while you are
  working inside the pi-dynamic-workflows checkout. Outside it, it prints a hint to
  run from within the repo (or use `npm run doctor`).
- It does **not** import `scripts/doctor.mjs` (that would break standalone loading);
  it runs it as a subprocess found at runtime, so the extension itself always loads.
- During onboarding, before `pi install ./` + `/reload`, use `npm run doctor` — the
  `/doctor` command only exists once the extension is loaded.
