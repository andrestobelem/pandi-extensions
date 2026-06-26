# Visualization of agentic patterns in Dynamic Workflows

Date: 2026-06-25

## Objective

Improve `/workflow graph` so it no longer looks like a linear list of calls and instead shows relevant agentic patterns: fan-out of many subagents per step, pipelines by lanes/stages, parallel barriers, synthesis/judge, and approximate loops. Explicit requirement: if a step launches many agents, that must be visible in the diagram; the inline PNG must appear larger.

## Sources reviewed

- Anthropic, **Building effective agents**: prompt chaining, routing, parallelization, orchestrator-workers, evaluator-optimizer.
- LangGraph, **Workflows and agents**: Mermaid/graph rendering of workflows, parallelization, routing, orchestrator-worker, evaluator-optimizer.
- Mermaid, **Flowchart syntax**: `subgraph`, local direction, edges to/from subgraphs, labels and shapes.
- Mermaid CLI (`mmdc`): flags `-w/--width`, `-H/--height`, `-s/--scale`, `-t`, `-b`, JSON config.
- Papers: ReAct (arXiv:2210.03629), Self-Consistency (arXiv:2203.11171), Reflexion (arXiv:2303.11366), Self-Refine (arXiv:2303.17651), Tree of Thoughts (arXiv:2305.10601), Multiagent Debate (arXiv:2305.14325).
- Local parallel research: workflow `generated/agentic-viz-patterns-research`, run `2026-06-25T10-17-20-913Z-generated-agentic-viz-patterns-research-ef06f94c`, artifacts in the project’s `.pi/workflow-runs/...` directory where it was run.

## Recommended visual grammar

- `◆ fan-out`: `ctx.agents(...)`; show `P1 ×items.length agents`, `concurrency`, `settle:true`, fork, visible workers, and join.
- `▣ pipeline`: `ctx.pipeline(items, ...stages)`; show `×items.length lanes` and number of stages.
- `⧉ barrier`: `ctx.parallel([...])`; show concurrent branches and join/barrier.
- `● agent`: an individual Pi subagent.
- `◇ workflow`: delegated sub-workflow.
- `▤ artifact`: evidence persisted outside the chat.
- `$ bash`: host command.
- Feedback loops (ReAct/Reflexion/Self-Refine) should be marked as loops with a stop condition when `for`/`while` are detected.

## Decisions implemented

1. **Enriched graph model**
   - `WorkflowGraphStep` can now carry `fanout` and `children`.
   - Conservative static cardinality is inferred: `angles.map(...)` → `angles.length`; literal arrays → number; unknown → `dynamic`.
   - `concurrency`, `settle:true`, and number of stages are extracted when they appear in arguments.

2. **Grouping nested calls**
   - `ctx.agent`/helper calls inside `ctx.pipeline`, `ctx.parallel`, or `ctx.agents` are shown as children of the orchestration step, not as independent serial steps.

3. **Mermaid with subgraphs**
   - Fan-outs/pipelines/barriers are rendered as `subgraph` with `direction LR`.
   - For many agents, representative workers are drawn: `agent 1`, `agent 2`, `…`, `agent n`, or `agent N`.
   - External connections point to the subgraph, not to internal nodes, so Mermaid’s local direction is not broken.

4. **Larger PNG**
   - Dynamic render: `width 2200..3600`, `height 1300..2800`, `scale=2`.
   - Larger inline TUI: up to `320` columns and `54..88` rows depending on complexity.
   - The UI shows generated dimensions (`WIDTH×HEIGHT @2x`) next to the PNG/MMD path.

5. **Documentation**
   - README and skill document that `/workflow graph` now shows fan-out `×N`, lanes/branches, and a large inline PNG.

## Accepted limitations

- The graph is still a static view: it does not execute JS or know the real value of `files.length` before the run.
- Real post-run counts exist in `phaseTotal`/`phaseIndex`/`phaseLabel` for `ctx.agents(...)`; a future run-aware improvement can combine the static graph with run events.
- Regex-based inference is still heuristic; an AST would be more robust, but this improvement avoids the most visible false serializations while keeping cost/dependencies low.
- Huge fan-outs are collapsed with ellipses for readability; the PNG shows that there are many agents without trying to draw hundreds by default.

## Validation

```bash
npm test
PI_DYNAMIC_WORKFLOWS_PI_COMMAND=true pi --no-extensions -e ./extensions/dynamic-workflows.ts --no-session -p "/workflow graph generated/agentic-viz-patterns-research"
./node_modules/.bin/mmdc -q -i /tmp/subgraph-id-edge.mmd -o /tmp/subgraph-id-edge.png -e png -t dark -b transparent -w 2600 -H 1800 -s 2
```
