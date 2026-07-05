---
name: github-project
description: >-
  Manage this repo's issue tracking on the GitHub Project v2
  "pandi-dynamic-workflows" (user andrestobelem, project #4) with the gh CLI.
  Use when creating stories/tasks/bugs, adding items to the board, moving
  Status (Todo / In Progress / Done), setting Priority (P0-P3) or Size (S/M/L),
  building epics with native sub-issues, managing milestones, closing work from
  commits, or answering "what is on the board / in progress / left to do /
  next by priority".
---

# github-project

All work on this repo is tracked as **repo issues** placed on the **GitHub
Project v2 board "pandi-dynamic-workflows"** (owner: user `andrestobelem`,
project `4`), driven entirely from the terminal with `gh`. This skill carries
the verified IDs and the exact command recipes so no session has to
re-discover them.

## Conventions (the contract)

- **Issues are the unit of work**, labelled by kind: `story` (user-facing
  story / epic), `task` (concrete task), `bug`, `tests` (test-suite work),
  `tech-debt` (debt / process improvement). Combine kind labels when honest
  (e.g. `task,tests`).
- **Board Status** groups items: `Todo` → `In Progress` → `Done`. Move an item
  to In Progress when you actually start it.
- **Close from the commit that finishes the work**: put `Closes #N` in the
  commit message body. When the commit lands on the default branch, GitHub
  closes the issue and the built-in project workflow moves its card to Done —
  no manual board edit needed.
- **Stories link their sub-tasks**: the parent story lists them in its body;
  each sub-task's body says `Part of #N`. Keep sub-tasks small and
  independently closeable.
- **The Project board is the source of truth** for planning state: `Priority`
  (P0 highest → P3) and `Size` (S/M/L) live as board fields, not only in
  grooming run artifacts. The `grooming` workflow analyzes and PROPOSES
  `item-edit` commands (propose-only); a human executes them. `sdlc` picks the
  next issue as the top-Priority `Todo` item. Run artifacts are snapshots; the
  board is current state.
- **Epics are native sub-issues**, not just body text: link children to the
  parent story with the `addSubIssue` GraphQL mutation (recipes below). GitHub
  then computes `Sub-issues progress` automatically and the board can
  group-by-parent. Keep the `Part of #N` body line as a human-readable
  courtesy; the sub-issue link is the machine truth.

## Verified constants (2026-07-04)

| What | Value |
| --- | --- |
| Repo | `andrestobelem/pandi-extensions` |
| Project | number `4`, owner `andrestobelem` (user project, private) |
| Project ID | `PVT_kwHOAEKsO84BcY5A` |
| Status field ID | `PVTSSF_lAHOAEKsO84BcY5AzhXCGf4` |
| Status option: Todo | `f75ad846` |
| Status option: In Progress | `47fc9ee4` |
| Status option: Done | `98236657` |
| Priority field ID | `PVTSSF_lAHOAEKsO84BcY5AzhXHPrs` |
| Priority options | P0 `5625c061` · P1 `431da638` · P2 `29bb2363` · P3 `01b46031` |
| Size field ID | `PVTSSF_lAHOAEKsO84BcY5AzhXHPrw` |
| Size options | S `cd9ee114` · M `b551b778` · L `254b9bf3` |

If an `item-edit` fails with an unknown field/option, re-derive the IDs (they
only change if the field is recreated):

```bash
gh project field-list 4 --owner andrestobelem --format json \
  --jq '.fields[] | select(.name == "Status" or .name == "Priority" or .name == "Size")
        | {name, id, options: [.options[] | {name, id}]}'
```

## Recipes

Preflight once per session if anything fails with auth errors: `gh auth status`
(the token must carry the `project` scope; `gh auth refresh -s project` fixes it).

### Create an issue and put it on the board

```bash
gh issue create --title "P5: cover pandi-effort parse errors" \
  --body "Part of #1. <what + why + evidence expected>" \
  --label task,tests
gh project item-add 4 --owner andrestobelem --url <issue-url-from-previous-output>
```

A freshly added item may have NO Status yet — set `Todo` explicitly with the
move recipe below so it shows up in the right column.

### Find a board item id from an issue number

`item-edit` needs the PVTI item id, not the issue number:

```bash
gh project item-list 4 --owner andrestobelem --limit 200 --format json \
  --jq '.items[] | select(.content.number == 2) | .id'
```

(Default `--limit` is 30 — always pass a generous one; the board already has ~26 items.)

### Move an item's Status

```bash
gh project item-edit --id <PVTI-item-id> \
  --project-id PVT_kwHOAEKsO84BcY5A \
  --field-id PVTSSF_lAHOAEKsO84BcY5AzhXCGf4 \
  --single-select-option-id 47fc9ee4   # Todo f75ad846 · In Progress 47fc9ee4 · Done 98236657
```

### Set Priority / Size on an item

Same `item-edit` shape as Status — one field per call (verified round-trip:
set → query → `--clear`):

```bash
gh project item-edit --id <PVTI-item-id> \
  --project-id PVT_kwHOAEKsO84BcY5A \
  --field-id PVTSSF_lAHOAEKsO84BcY5AzhXHPrs \
  --single-select-option-id 431da638   # P0 5625c061 · P1 431da638 · P2 29bb2363 · P3 01b46031
# Size: --field-id PVTSSF_lAHOAEKsO84BcY5AzhXHPrw · S cd9ee114 · M b551b778 · L 254b9bf3
# Unset a field: same call with --clear instead of --single-select-option-id
```

### Pick the next work item (top-Priority Todo)

In `item-list` JSON the field keys are lowercased (`priority`, `size`); items
without the field have `null`:

```bash
gh project item-list 4 --owner andrestobelem --limit 200 --format json \
  --jq '[.items[] | select(.status == "Todo" and .priority != null)]
        | sort_by(.priority) | .[0:5]
        | .[] | "\(.priority) #\(.content.number) \(.title)"'
```

(`sort_by(.priority)` works because P0 < P1 < … sorts lexicographically.)

### Epics: native sub-issues

Sub-issue operations are GraphQL-only (no `gh project`/`gh issue` subcommand).
`addSubIssue` accepts the child's URL directly — no node-ID dance (input shape
schema-verified; mutations exercised on demand):

```bash
# Link a child issue to its parent story (epic)
PARENT_ID=$(gh api graphql -f query='{ repository(owner:"andrestobelem", name:"pandi-dynamic-workflows")
  { issue(number:<PARENT>) { id } }}' --jq .data.repository.issue.id)
gh api graphql -f query="mutation { addSubIssue(input: { issueId: \"$PARENT_ID\",
  subIssueUrl: \"https://github.com/andrestobelem/pandi-extensions/issues/<CHILD>\" })
  { issue { number } subIssue { number } } }"

# List an epic's children + auto-computed progress
gh api graphql -f query='{ repository(owner:"andrestobelem", name:"pandi-dynamic-workflows")
  { issue(number:<PARENT>) { subIssuesSummary { total completed percentCompleted }
    subIssues(first: 50) { nodes { number title state } } } }}' --jq .data.repository.issue

# Unlink / reorder children: removeSubIssue · reprioritizeSubIssue (same input style)
```

The board surfaces this via the built-in `Parent issue` and `Sub-issues
progress` fields (group a table view by Parent issue in the UI).

### Milestones (release buckets)

```bash
gh api repos/andrestobelem/pandi-extensions/milestones -f title="v0.2 release" \
  -f description="<anchor story / scope>"          # create
gh issue edit <N> --milestone "v0.2 release"       # assign
gh issue list --milestone "v0.2 release"           # query
```

The board's built-in `Milestone` field picks these up automatically.

### Finish work

Prefer closing from the landing commit (`Closes #N` in the body) over manual
closes. Manual fallback: `gh issue close <N> --comment "<evidence>"` — the
project workflow still moves the card to Done.

### Query the board

```bash
# Everything, grouped fields flattened: id | status | issue | labels | title
gh project item-list 4 --owner andrestobelem --limit 200 --format json \
  --jq '.items[] | [.id, .status, "#\(.content.number)", (.labels | join(",")), .title] | @tsv'

# Only what is in progress (or Todo / Done)
gh project item-list 4 --owner andrestobelem --limit 200 --format json \
  --jq '.items[] | select(.status == "In Progress") | "#\(.content.number) \(.title)"'
```

Issue-side queries stay on the repo: `gh issue list --label task --state open`.

## Gotchas

- `gh project` subcommands need `--owner andrestobelem` every time — without it
  gh guesses from the repo and user projects are not found.
- `item-list` JSON: `status` is a plain string (`"Todo"` / `"In Progress"` /
  `"Done"`), the issue number is `content.number`, labels is a string array.
- The project is **private**: link cards by issue number in text, don't expect
  external viewers to resolve project URLs.
- One `item-edit` sets ONE field; Status moves and other field edits are
  separate calls.
- `gh project field-create` only supports `TEXT|SINGLE_SELECT|DATE|NUMBER` —
  **Iteration fields cannot be created from the CLI** (UI-only); reading/setting
  them via GraphQL works once created.
- Sub-issue mutations (`addSubIssue` / `removeSubIssue` / `reprioritizeSubIssue`)
  exist only in GraphQL; the parent must be passed as a node ID (`issueId`),
  the child can be a plain `subIssueUrl`.
- New single-select fields created via CLI get auto-generated option IDs —
  record them here immediately (table above) so no session re-derives them.
