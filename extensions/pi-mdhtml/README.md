# @pandi-coding-agent/mdhtml

Individual Pi package for the `/mdhtml` Markdown → HTML converter extension.

## Install

From this repository:

```bash
pi install ./extensions/pi-mdhtml
pi install -l ./extensions/pi-mdhtml
pi --no-extensions -e ./extensions/pi-mdhtml
```

## Provides

- `/mdhtml <in.md> [more.md…] [-o out.html] [--kicker "Text"]` — convert Markdown
  files into self-contained HTML artifacts styled with the pandi artifact style
  (Claude-design layout × Panda Syntax palette, light + dark).
- `markdown_to_html` — the model-callable counterpart, so the agent itself can
  produce a styled HTML report from a Markdown file.
- The vendored `pandi-artifact-style` skill (style manual + tokens + template);
  the converter reads `skills/pandi-artifact-style/reference/pandi-tokens.css`
  at runtime, so the package is self-contained.

The converter itself is a plain-node CLI too:

```bash
node extensions/pi-mdhtml/scripts/md-to-html.mjs in.md -o out.html --kicker "Informe"
```

Details (mermaid support, GitHub alerts → callouts, title/kicker rules) are in the
[pandi-artifact-style skill](./skills/pandi-artifact-style/SKILL.md). In-repo, the
vendored skill tree is a GENERATED mirror of `.pi/skills/pandi-artifact-style/`
(`npm run sync:skills:vendor`) — edit the `.pi` source, not the copy.

For the full bundle of extensions and skills, install the repository root instead.
