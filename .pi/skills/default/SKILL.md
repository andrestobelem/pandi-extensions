---
name: default
description: Use when the user asks for the legacy default Dynamic Workflows pattern. Route to the fan-out-and-synthesize pattern.
---

# Default dynamic workflow

Use the Dynamic Workflows `fan-out-and-synthesize` pattern for this request.

1. Treat the user's task as input for `fan-out-and-synthesize`.
2. Inspect the pattern first with `dynamic_workflow action=template name=fan-out-and-synthesize` when you need the scaffold.
3. If a workflow is warranted, run or draft `fan-out-and-synthesize` rather than resolving `default` as a pattern alias.
4. Preserve the normal router gates: scout first, orchestrate only for scale, confidence, or exhaustiveness.
