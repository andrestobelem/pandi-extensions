# @pandi-coding-agent/pandi-doctor

Adds `/doctor`, an in-session shortcut for the pandi-extensions environment
check. It answers "is my machine set up right?" without leaving the chat —
the same read-only report as `npm run doctor`, one keystroke away.

## Quickstart

```text
/doctor
```

```text
pandi-extensions doctor

Obligatorios:
  ✓ Node.js 22.19.0 — ≥ 22.19.0
...

✓ Todos los requisitos obligatorios están presentes.
```

The command finds `scripts/doctor.mjs`, runs it, and shows the report as an
`info` (all mandatory checks pass), `error` (non-zero exit or timeout), or
`warning` (script not found) message.

## Install

| Mode | Command | When to use it |
| --- | --- | --- |
| From npm | `pi install npm:@pandi-coding-agent/pandi-doctor` | Standalone use, outside this repo |
| Global | `pi install ./extensions/pandi-doctor` | You want `/doctor` in every session |
| Project-local | `pi install -l ./extensions/pandi-doctor` | Only this project should get `/doctor` |
| One-off trial | `pi --no-extensions -e ./extensions/pandi-doctor` | Try it with nothing else loaded |

## Commands

| Command | What it does |
| --- | --- |
| `/doctor` | Run the environment check (`scripts/doctor.mjs`) and show the report. |

## How it works

- Walks up from the session cwd looking for a working-tree copy
  (`<repo>/extensions/pandi-doctor/scripts/doctor.mjs`), so in-repo dev always
  runs the freshest version; falls back to the vendored copy shipped in the
  npm tarball for standalone installs.
- Spawns it with `node` using an argv array — never a shell string — and
  captures the output with `NO_COLOR` set, so the report is plain text.
- Runs the script as a subprocess found at runtime instead of importing it: a
  static import would break bundling, so the extension itself always loads.

## Limitations & safety notes

- Standalone installs degrade honestly: `sync Claude global` reports `N/A`
  outside the suite repo, local `node_modules` probes use the session cwd,
  and the double-copy check skips working-tree detection.
- During onboarding, before `pi install ./` + `/reload`, use `npm run doctor`
  instead — `/doctor` only exists once the extension is loaded.
- The outer `/doctor` subprocess times out after 120 seconds and reports the timeout as an error. Override with `PI_DOCTOR_TIMEOUT_MS` when a slower environment needs more room.
- Internal probes are bounded too: `PI_DOCTOR_PROBE_TIMEOUT_MS` controls quick binary/git probes (default 8s), and `PI_DOCTOR_SYNC_TIMEOUT_MS` controls repo sync checks (default 20s).
- Timeout overrides are millisecond values clamped to at least 1000ms; invalid values fall back to the defaults instead of disabling the guard.

## Related

For the full bundle of extensions and skills, install the repository root
instead.
