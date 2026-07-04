---
name: pandi-artifact-style
description: >-
  Style manual for artifacts produced in or from this repo: self-contained HTML
  reports/dashboards, workflow run artifacts, informes, and styled
  documentation. Use whenever generating an HTML artifact, report, dashboard,
  or presentation-quality document so it follows the Claude-design layout
  language with the Pandi (Panda Syntax) palette in light and dark variants.
---

# Pandi artifact style

One look, everywhere: Claude-design structure and typography, colored with the
Panda Syntax palette. Apply this to every presentation-quality artifact — HTML
reports, dashboards, `writeArtifact()` HTML outputs, informes, and styled
docs — so a reader recognizes a pandi artifact on sight. 🐼

**Source of truth for colors:** `extensions/pandi-theme/themes/panda-syntax-dark.json`
and `panda-syntax-light.json`. Never invent new hues — map every color to a
token below. If the theme changes, this skill's tokens must be updated to match.

## Design principles (Claude design)

1. **Paper and ink.** A calm page surface (`--bg`) with slightly raised cards
   (`--paper`) separated by subtle 1px borders (`--line`). No shadows, no
   gradients. Rounded corners: 10–12px for cards, 999px for chips/pills.
2. **Quiet hierarchy.** One accent color does the pointing (`--accent`, panda
   pink). Headings are small and structural, not loud: a 12px uppercase
   letterspaced *kicker* above a 28px `h1`; section headings are 13px uppercase
   letterspaced in `--muted`.
3. **Generous whitespace.** Container max-width ~980px, 24px side padding,
   40px header top padding, 80px bottom. Body copy at `15px/1.65` in the system
   sans stack; prose measure ≤ ~74ch.
4. **Monospace for identity.** IDs, paths, models, and code use
   `ui-monospace, Menlo, monospace` — never for prose.
5. **Evidence over decoration.** Status is shown with tinted pills/callouts
   (ok/run/fail), not icons or emoji. Failed or skipped work is always visible
   (error/warn callouts), never hidden.
6. **Self-contained.** One file, inline CSS, no build step. Allowed CDNs (only
   when actually needed): mermaid, highlight.js, marked — the ones already used
   by `.claude/scripts/lib/render.mjs`.

## Palette — semantic tokens

Dark is the base (matches the TUI default); light activates via
`prefers-color-scheme`. Full copy-paste block: [`reference/pandi-tokens.css`](./reference/pandi-tokens.css).

| Token | Role | Dark | Light | Theme source |
|---|---|---|---|---|
| `--bg` | page background | `#242526` | `#ECECEC` | `export.pageBg` |
| `--paper` | cards, blocks | `#292A2B` | `#F2F1F1` | `export.cardBg` |
| `--info-bg` | info callout surface | `#2E2A33` | `#EDE4F8` | `export.infoBg` |
| `--raised` | hover/selected, chips, code bg | `#31353A` | `#E6DBCB` | `seal` / `sel` |
| `--ink` | primary text | `#E6E6E6` | `#222223` | `fg` |
| `--ink2` | secondary text | `#BBBBBB` | `#676B79` | `contrast` / `comment` |
| `--muted` | tertiary text, section headings | `#757575` | `#8D8D8D` | `lightGray` / `dim` |
| `--line` | subtle borders | `#3E4250` | `#C9C9C9` | `steel` / `borderLt` |
| `--line-strong` | hr, emphasized borders | `#676B79` | `#676B79` | `midnight` / `comment` |
| `--accent` | kicker, primary accent | `#FF75B5` | `#FF0077` | `pink` |
| `--link` | links | `#6FC1FF` | `#0091FF` | `lightBlue` / `blue` |
| `--info` | titles, running state | `#45A9F9` | `#0091FF` | `blue` |
| `--success` | ok states | `#19F9D8` | `#12B69D` | `green` / `teal` |
| `--warning` | caps, clamps, partial work | `#FFCC95` | `#FF8400` | `lightOrange` / `orange` |
| `--error` | failures, blockers | `#FF4B82` | `#FF4B82` | `lightRed` / `red` |
| `--code` | inline code | `#19F9D8` | `#12B69D` | `mdCode` |
| `--purple` | types, extras | `#BCAAFE` | `#B084EB` | `lightPurple` / `purple` |
| `--success-bg` / `--error-bg` / `--warning-bg` | tinted callout surfaces | `#1E2E2B` / `#2E1E24` / `#2E2A33` | `#DCEEEA` / `#F7DCE4` / `#EDE4F8` | `toolSuccessBg` / `toolErrorBg` / `export.infoBg` |

Syntax highlighting in code blocks follows the theme: keywords pink, functions
blue, strings green, numbers orange, types purple, comments `--line-strong`.

## Component recipes

Working markup + CSS for all of these: [`reference/template.html`](./reference/template.html)
(open it in a browser to check both variants). Summary:

- **Header**: kicker (12px uppercase `.12em` tracking, `--accent`, weight 600) →
  `h1` 28px → one-paragraph summary in `--ink2` → a `chips` row for metadata
  (date, run id, counts).
- **Chips**: 12px text, `4px 10px` padding, radius 999px, `--raised` background,
  `--line` border.
- **Status pills** (`ok`/`run`/`fail`): 11px bold, tinted background
  (`--success-bg`/`--info-bg`/`--error-bg`) with matching text/border color.
- **Cards**: `--paper` on `--line` border, radius 12px; clickable head row
  (caret + monospace id in `--info` + title + right-aligned pill); collapsible
  body in `--ink2` separated by a top border.
- **Callouts**: info/success/warn/error — tinted surface, colored border,
  primary-ink text with a bold lead word.
- **Tables**: full-width inside a rounded `--paper` frame; uppercase 12px
  header row on `--raised`; row separators with `--line` only.
- **Code**: inline `code` in `--code` on `--raised`; blocks in a `--paper`
  rounded frame at 12.5px/1.6.
- **Quotes**: 3px `--accent` left border, text in `--ink2`.

## Rules for HTML artifacts

1. Start from `reference/template.html`; keep the token block byte-identical to
   `reference/pandi-tokens.css` unless the theme JSONs changed.
2. Single self-contained file; inline all CSS/JS except the allowed CDNs.
3. Support both schemes via `prefers-color-scheme` — never ship dark-only.
4. Escape untrusted content interpolated into HTML (`<`, `>`, `&`), as
   `render.mjs` does for its JSON blob.
5. Surface partial failure: failed/skipped/clamped work gets a warn or error
   callout near the top, not a footnote.
6. Footer line in `--muted` 12.5px: generator + palette attribution.
7. Mermaid diagrams must use the pandi palette too: mermaid `base` theme with
   `themeVariables` mapped from the tokens (background/mainBkg/primaryColor from the
   surfaces, text from the inks, `titleColor` from the accent, lines from `--muted`).
   Reference implementation: `mermaidThemeVariables()` in
   `extensions/pandi-docs/scripts/markdown-to-html.mjs` — copy it instead of inventing
   a new mapping.

## Converting Markdown to styled HTML

Use the `pandi-docs` extension instead of hand-writing the shell — it owns the
converter (`extensions/pandi-docs/scripts/markdown-to-html.mjs`):

- **In a Pi session**: the `/docs` command (human) or the `markdown_to_html`
  tool (model): `/docs in.md [more.md…] [-o out.html] [--kicker "Informe"]`.
- **From the shell**:

```bash
npm run md:html -- docs/research/example.md            # writes example.html next to it
node extensions/pandi-docs/scripts/markdown-to-html.mjs in.md -o out.html --kicker "Informe"
```

- Accepts multiple `.md` inputs (each writes a sibling `.html`); `-o` only with one.
- The first `# h1` becomes the page title/header; `--kicker` sets the kicker
  (default `Pandi artifact`).
- GitHub alerts (`> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION]`) become pandi callouts.
- Prose typography: `h2`/`h3`/`h4` are real ink headings (20/16/14px) and body text
  is justified — the uppercase label style stays dashboard-only (`h2.sec` in the template).
- ` ```mermaid ` fences render as diagrams themed with the pandi palette (mermaid `base`
  theme + `themeVariables` parsed at runtime from the tokens file; dark/light follows
  `prefers-color-scheme`). The CDN script is injected only when a diagram exists —
  diagram-free documents stay JS-free.
- Tokens are read at runtime from this skill's [`reference/pandi-tokens.css`](./reference/pandi-tokens.css)
  (the extension carries a vendored, byte-identical copy of the skill) — output is a
  single self-contained file with no JS.
- Pinning tests: `extensions/pandi-docs/tests/integration/markdown-to-html.test.mjs` (`npm test`).

## Rules for Markdown reports (informes)

- Follow `docs/` conventions: include date, context, affected files, and next
  steps; research notes go to `docs/research/`, durable guides to
  `docs/handbooks/`.
- Lint with the `markdownlint-cli2` skill before finishing.
- Markdown gets no custom styling — structure does the work: one `h1`, short
  sections, tables for comparisons, fenced code for evidence.
