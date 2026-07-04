# @pandi-coding-agent/pandi-worktree

Git worktrees let you check out several branches into separate folders at once,
without stashing or re-cloning. This extension manages them from inside a Pi
session: list, add, open, remove, and prune — via an interactive `/worktree`
command or a model-callable `git_worktree` tool, so Pi (or you) never has to
hand-write `git worktree` bash commands.

```bash
/worktree add -b feature/login my-feature
# → Added worktree at /Users/you/repo/.pi/worktrees/my-feature (new branch feature/login) (default .pi/worktrees/)
```

## Install

```bash
pi install npm:@pandi-coding-agent/pandi-worktree     # from npm

pi install ./extensions/pandi-worktree             # from this repo, global
pi install -l ./extensions/pandi-worktree          # from this repo, project-local
pi --no-extensions -e ./extensions/pandi-worktree  # one-off trial, nothing else loaded
```

## What you get

- `/worktree` slash command with confirmations, subcommand completions, and an
  interactive list/add/remove/prune menu in a TUI.
- `git_worktree` model tool with explicit actions and no surprise deletes.
- Optional copying of gitignored (e.g. `node_modules`) and/or untracked files
  into a newly created worktree.
- A gitignored default home for bare-named worktrees: `.pi/worktrees/<name>`.

## Commands

| Command | What it does |
| --- | --- |
| `/worktree` (no args) | List worktrees; in a TUI, an interactive menu (list/add/remove/prune). |
| `/worktree list` (or `ls`) | List worktrees with their absolute paths. |
| `/worktree add [-b <branch>] [--detach] [--force] [--copy-ignored] [--copy-untracked] <path> [<commit-ish>]` | Add a worktree; `-b` creates and checks out a new branch. |
| `/worktree open [same flags as add] <path> [<commit-ish>]` | Create the worktree if missing, then open a new Pi session in it. |
| `/worktree remove [--force] <path>` (or `rm`) | Remove a worktree (confirms first). |
| `/worktree prune [--dry-run]` | Prune stale worktree metadata (always previews first). |
| `/worktree set [copy-ignored\|copy-untracked] [on\|off\|status]` | Set or show the session's copy defaults. |
| `git_worktree` | Model tool: `action` (`list`/`add`/`open`/`remove`/`prune`) plus `path`, `branch`, `commitish`, `detach`, `force`, `dryRun`, `copyIgnored`, `copyUntracked`; returns a text summary and structured `details`. |

Example tool call:

```json
{ "action": "add", "path": "my-feature", "branch": "feature/login" }
```

## How it works

- **`open` never moves your session.** Pi's `cwd` is fixed for the session, so
  `open` starts a *separate* Pi session in the worktree instead. Under
  Supacode it opens a new tab (`supacode tab new -n <tabId> -i 'cd <path> &&
  exec pi'`, with a client-generated `-n <tabId>` confirmed via `tab list` to
  work around Supacode's missing TTY ack); otherwise it reports the
  `cd <path> && pi` command for you to run. A
  long-running `/loop` or `/goal` in the current session stays untouched.
- **Bare names get a default home.** A `<name>` with no path separator lands
  in `<repo>/.pi/worktrees/<name>`, gitignored automatically (a
  `.pi/worktrees/.gitignore` containing `*` is written on first use). Use an
  explicit path (`./x`, `../x`, `/abs/x`, `~/x`) to place it elsewhere.
- **Copy options** (`--copy-ignored`, `--copy-untracked`; tool params
  `copyIgnored`, `copyUntracked`) copy gitignored and/or untracked files from
  the main worktree into a *newly created* one. The worktrees base dir and
  `.git` are never copied, so a worktree never recursively fills with other
  worktrees.
- **Copy resolution precedence** (highest wins): explicit per-call flag →
  session default → environment → off.
  1. Per call: `--copy-ignored`/`--copy-untracked` force ON; `--no-copy-ignored`
     /`--no-copy-untracked` force OFF. Tool params are tri-state (`true`,
     `false`, or omitted to fall through).
  2. Session default: `/worktree set copy-ignored on|off` and `/worktree set
     copy-untracked on|off`; `/worktree set` (or `… status`) reports the
     current resolution. Defaults reset at each session boundary.
  3. Environment: `PI_WORKTREE_COPY_IGNORED` / `PI_WORKTREE_COPY_UNTRACKED`
     (truthy tokens: `1`/`true`/`on`/`yes`).

## Limitations & safety notes

- `git` is always spawned with an argv array — never a shell string — so
  paths and branch names cannot inject shell commands.
- `remove` confirms first; if the worktree is dirty or locked, git refuses and
  you get a second, explicit "force removal" confirmation. The tool never
  force-deletes by default: it discards a dirty worktree only with an
  explicit `force: true`.
- `/worktree prune` (the slash command) always shows a `--dry-run`-equivalent
  preview before deleting anything and confirms before the real run; the
  `git_worktree` tool's `prune` action makes a single call and deletes
  immediately unless the caller passes `dryRun: true`.
- This extension never switches the **current** session's working directory
  into another worktree; it opens new sessions instead.

## Related

For the full bundle of extensions and skills, install the repository root
instead.
