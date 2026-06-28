# pi-dynamic-workflows-mdview

Individual Pi package for the `/mdview` Markdown viewer extension.

## Install

From this repository:

```bash
pi install ./extensions/pi-mdview
pi install -l ./extensions/pi-mdview
pi --no-extensions -e ./extensions/pi-mdview
```

## Provides

- `/mdview <path>` — open a Markdown file in Pi's TUI with scroll controls.

In non-TUI modes the command prints the Markdown content to the terminal. Under
`--print`/`--json`, pi reserves real stdout for the model response and routes
extension output to stderr, so the content is **not** redirectable to a file
(`pi /mdview f.md > out.md` captures nothing — use `cat` to dump raw Markdown).

For the full bundle of extensions and skills, install the repository root instead.
