# @pandi-coding-agent/docs

Convert Markdown files into self-contained HTML artifacts styled with the pandi artifact style (Claude-design layout, Panda Syntax palette, light + dark) — via a `/docs` command, a model-callable tool, or a plain Node CLI.

## What you get

- `/docs` command for converting one or more Markdown files by hand.
- `markdown_to_html` tool so the agent itself can produce a styled HTML report.
- The vendored `pandi-artifact-style` skill (style manual + tokens + template); the converter reads `skills/pandi-artifact-style/reference/pandi-tokens.css` at runtime, so the package is self-contained.

## Install

From this repository:

```bash
pi install ./extensions/pi-docs          # global (your user)
pi install -l ./extensions/pi-docs       # project-local
pi --no-extensions -e ./extensions/pi-docs   # one-off trial, nothing else loaded
```

## Commands

| Command | What it does |
| --- | --- |
| `/docs <in.md> [more.md…] [-o out.html] [--kicker "Text"]` | Convert Markdown files to pandi-styled HTML. Output defaults to the input with `.md` swapped for `.html`; `-o` is only valid with a single input. |
| `markdown_to_html` | Model tool: same converter for the agent, with `path`, optional `out`, and optional `kicker` parameters. |

## How it works

The converter is also a plain-node CLI:

```bash
node extensions/pi-docs/scripts/markdown-to-html.mjs in.md -o out.html --kicker "Informe"
```

Details on mermaid support, GitHub alerts → callouts, and title/kicker rules are in the [pandi-artifact-style skill](./skills/pandi-artifact-style/SKILL.md).

## Details

In-repo, the vendored skill tree is a GENERATED mirror of `.pi/skills/pandi-artifact-style/` (`npm run sync:skills:vendor`) — edit the `.pi` source, not the copy.

## Related

For the full bundle of extensions and skills, install the repository root instead.
