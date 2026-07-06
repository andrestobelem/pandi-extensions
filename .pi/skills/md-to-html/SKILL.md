---
name: md-to-html
description: >-
  Convert one markdown doc into a self-contained, pandi-styled HTML page with
  the pandi-docs converter. Use when asked to create an HTML version/mirror of
  a markdown doc, hand someone a report as a single .html, or style a doc with
  a project's own palette or stylesheet. Invoked with /md-to-html
  <path/to/doc.md>.
---

# md-to-html

Convert one markdown doc into a self-contained, styled HTML page — one file,
no build step, light + dark baked in.

## Pick the surface

- **Inside a pi session:** use the `/docs` command or the `markdown_to_html`
  tool from the `pandi-docs` extension — same converter with path resolution
  and feedback on top. Prefer these when available.
- **Anywhere else (Claude Code, CI, plain shell):** run the CLI. The converter
  ships with the installed package
  (`node_modules/@pandi-coding-agent/pandi-docs/scripts/markdown-to-html.mjs`)
  or a checkout of pandi-extensions
  (`extensions/pandi-docs/scripts/markdown-to-html.mjs`).

## Steps

1. Generate (output lands next to the source unless `-o` is given):

   ```bash
   node <converter>/markdown-to-html.mjs <path/to/doc.md> --kicker "Proyecto · Área"
   ```

   Pick the kicker from the doc's area (`Policy`, `Research`, `Informe`,
   `Docs`); default is `Pandi artifact`.
2. Styling beyond the default pandi look:
   - `--tokens palette.css` — swap only the color palette (custom properties),
     keeping the pandi layout.
   - `--css style.css` — replace the entire stylesheet with the project's own
     (wins over `--tokens`).
3. Open or read the output to sanity-check: masthead title from the first
   `# h1`, kicker, TOC (appears at 4+ `##` sections), labeled callouts from
   `[!NOTE]`-style markers, highlighted code fences, mermaid diagrams.
4. If the doc should stay permanently mirrored, add it to the repo's
   `mirrors.json` and hand off to `/sync-doc-mirrors` — that flow owns
   check/sync, redeploy reminders, and orphan pruning.

## Notes

- The markdown is the source of truth — never edit the generated `.html` by hand.
- The full look-and-feel contract (tokens, layout, callouts, mermaid theming)
  lives in the `pandi-artifact-style` skill.
