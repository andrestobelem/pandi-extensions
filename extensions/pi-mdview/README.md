# @pandi-coding-agent/mdview

Reading a `.md` file usually means leaving the terminal for an editor or a
browser tab. `pi-mdview` adds a scrollable Markdown viewer straight to Pi's
TUI, plus a `view_markdown` tool so the agent can open a file for you (e.g.
after writing a report). Reach for it whenever you or the model need to read
a Markdown file without breaking flow.

```text
/mdview docs/scaffolds/map-reduce.md
```

That opens the file in-place with `↑/↓`/`j/k` to scroll, `PgUp/PgDn` to
page, and `q`/`Esc` to close. Outside a TUI (e.g. `--print`), it just prints
the raw Markdown to the terminal.

## Install

From npm:

```bash
pi install npm:@pandi-coding-agent/mdview
```

From this repository:

```bash
pi install ./extensions/pi-mdview          # global (your user)
pi install -l ./extensions/pi-mdview       # project-local
pi --no-extensions -e ./extensions/pi-mdview   # one-off trial, nothing else loaded
```

## Reference

| Command | What it does |
| --- | --- |
| `/mdview <path>` | Open a Markdown file in Pi's TUI with scroll controls (`↑/↓` or `j/k`, `PgUp/PgDn`, `q`/`Esc` to close). Paths are cwd-relative, `~`-expanded, or absolute. |
| `view_markdown` | Model tool: same viewer, callable by the agent (e.g. "open README.md for me"); in non-interactive modes it returns the raw Markdown content instead. |

## Limitations & safety notes

- Files larger than 2 MB are refused — parsing a huge file would block the TUI event loop.
- In non-TUI modes `/mdview` prints the Markdown to the terminal. Under `--print`/`--json`, pi reserves real stdout for the model response and routes extension output to stderr, so the content is **not** redirectable to a file (`pi /mdview f.md > out.md` captures nothing — use `cat` to dump raw Markdown).

## Related

For the full bundle of extensions and skills, install the repository root instead.
