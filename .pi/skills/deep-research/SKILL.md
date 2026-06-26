---
name: deep-research
description: Use when the user asks for deep research, source-backed research, or invokes the legacy deep-research intent. Route to the Dynamic Workflows complex-research pattern.
---

# Deep research

Use the Dynamic Workflows `complex-research` pattern for this request.

1. Treat the user's request as the `question` for `complex-research`.
2. Inspect the pattern first with `dynamic_workflow action=template name=complex-research` when you need the scaffold.
3. If a workflow is warranted, run or draft `complex-research` rather than resolving `deep-research` as a pattern alias.
4. Keep research branches read-only and require citations/evidence in the synthesis.
