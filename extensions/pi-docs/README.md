# @pandi-coding-agent/docs

Turns a Markdown file into a self-contained, styled HTML artifact — one file,
no build step, light + dark themes baked in via the pandi-artifact-style
skill (Claude-design layout, Panda Syntax palette). Reach for it whenever you
need to hand someone a report or informe as a single `.html` they can open
straight from disk or email.

```bash
/docs README.md --kicker "Informe"
# → Wrote README.html
```

## Install

From npm:

```bash
pi install npm:@pandi-coding-agent/docs
```

From this repository:

```bash
pi install ./extensions/pi-docs          # global (your user)
pi install -l ./extensions/pi-docs       # project-local
pi --no-extensions -e ./extensions/pi-docs   # one-off trial, nothing else loaded
```

## Reference

| Surface | Signature | Notes |
| --- | --- | --- |
| `/docs` command | `/docs <in.md> [more.md…] [-o\|--out out.html] [--kicker "Text"] [-h\|--help]` | Output defaults to the input with `.md` swapped for `.html`; `-o`/`--out` is only valid with a single input. |
| `markdown_to_html` tool | `path`, optional `out`, optional `kicker` | Model-callable counterpart of `/docs` (agents can't type slash commands). |
| CLI | `node extensions/pi-docs/scripts/markdown-to-html.mjs in.md -o out.html --kicker "Informe"` | Same converter, usable outside a pi session. |

All three surfaces share one implementation (`scripts/markdown-to-html.mjs`);
`/docs` and `markdown_to_html` add path resolution (`~`, cwd) and writing
feedback on top of it.

Details on mermaid support, GitHub alerts → callouts, and title/kicker rules
are in the [pandi-artifact-style skill](./skills/pandi-artifact-style/SKILL.md).

## Details

The converter reads pandi tokens from `skills/pandi-artifact-style/reference/pandi-tokens.css`
at call time, so the package is self-contained even when installed standalone.
In-repo, that vendored skill tree is a GENERATED mirror of
`.pi/skills/pandi-artifact-style/` (`npm run sync:skills:vendor`) — edit the
`.pi` source, not the copy.

## Related

For the full bundle of extensions and skills, install the repository root instead.
