---
name: markdownlint-cli2
description: >-
  Use markdownlint-cli2 in this repository to lint or fix Markdown files with
  the same DavidAnson markdownlint engine used by the VS Code markdownlint
  extension. Use when creating, editing, reviewing, or validating Markdown.
---

# markdownlint-cli2

Use this skill whenever a task creates, edits, reviews, or validates Markdown in this repository.

## Commands

- Whole-repo check:

  ```bash
  npm run lint:md
  ```

- Whole-repo auto-fix, only when the user explicitly wants broad Markdown edits:

  ```bash
  npm run lint:md:fix
  ```

- Targeted check for a few files:

  ```bash
  npx markdownlint-cli2 ":README.md" ":docs/example.md"
  ```

- Targeted auto-fix for files you intentionally touched:

  ```bash
  npx markdownlint-cli2 --fix ":README.md" ":docs/example.md"
  ```

Use the `:` prefix for literal paths so glob characters in file names are not expanded.

## Repository configuration

The repo config lives at `.markdownlint-cli2.jsonc` and is intentionally a legacy-friendly baseline:

- lints `**/*.md` by default;
- respects `.gitignore`;
- ignores generated/ephemeral paths like `.pi/**`, `.cache/**`, and `node_modules/**`;
- ignores `docs/conversaciones/**` because conversation transcripts intentionally repeat headings;
- relaxes noisy historical-doc rules while keeping default markdownlint checks otherwise enabled.

## Workflow

1. Before editing, inspect the target file and current git status so you do not rewrite unrelated dirty files.
2. After editing Markdown, run a targeted check on the files you touched.
3. If the target check fails, fix only the reported issues in those files, then re-run the targeted check.
4. Run `npm run lint:md` when the task asks for whole-repo validation or before claiming the repo Markdown configuration itself works.
5. Report the exact command and result.

## Cautions

- Do not run broad `npm run lint:md:fix` in a dirty tree unless the user explicitly asked for whole-repo Markdown cleanup.
- If lint reports pre-existing issues outside your touched files, preserve them and mention them instead of opportunistically rewriting them.
- The formatter/linter is `markdownlint-cli2`, not the older `markdownlint-cli`; it matches the DavidAnson markdownlint ecosystem used by the VS Code extension.
