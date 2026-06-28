# pi-worktree

Manage [git worktrees](https://git-scm.com/docs/git-worktree) from inside a Pi
session. Two surfaces:

- **`/worktree`** — human slash command (interactive, with confirmations and
  subcommand completions).
- **`git_worktree`** — a model-callable tool so Pi can list/add/remove/prune
  worktrees on its own instead of hand-writing `git worktree` bash commands.

Both share the same pure helpers, and `git` is always spawned with an **argv
array (never a shell string)**, so paths and branch names cannot inject shell
commands.

## Command

```text
/worktree                                  list worktrees (interactive menu in a TUI)
/worktree list                             list worktrees
/worktree add [-b <branch>] [--detach] [--force] <path> [<commit-ish>]   add a worktree
/worktree remove [--force] <path>          remove a worktree (confirms first)
/worktree prune [--dry-run]                prune stale worktree metadata (previews first)
```

- `add -b <branch> <path>` creates a new branch and checks it out in the new
  worktree.
- A **bare `<name>`** (no path separator) is created under the default base
  `.pi/worktrees/<name>`, which is kept local and gitignored automatically (a
  `.pi/worktrees/.gitignore` containing `*` is written on first use). Use an
  explicit path — `./x`, `../x`, `/abs/x`, or `~/x` — to place it elsewhere.
- `remove` asks for confirmation; if the worktree is dirty or locked, git
  refuses and you get a second, explicit "force removal" confirmation.
- `prune` always shows a `--dry-run` preview before deleting anything.

## Tool

The `git_worktree` tool takes an `action` (`list` | `add` | `remove` | `prune`)
plus `path`, `branch`, `commitish`, `detach`, `force`, and `dryRun`. It returns a
text summary and structured `details` (the parsed worktree list, the created
path, etc.). It **never force-deletes by default**: `remove` only discards a
dirty worktree when `force: true` is passed explicitly.

## Default location

Giving `add` a bare name (no `/`) drops the worktree in `.pi/worktrees/<name>`
relative to the repo, so all session-local worktrees live in one gitignored
place:

```text
/worktree add -b feat feat     →  <repo>/.pi/worktrees/feat   (gitignored)
/worktree add ../feat          →  <repo>/../feat              (explicit, literal)
```

## Note on `cwd`

Pi's working directory is fixed for the session and cannot change mid-session.
This extension therefore does not try to "switch" Pi into another worktree — it
reports each worktree's **absolute path** so you can open a new Pi there:

```sh
cd <worktree-path> && pi
```

## Install

```sh
pi install ./extensions/pi-worktree
# or, to try without installing:
pi --no-extensions -e ./extensions/pi-worktree
```
