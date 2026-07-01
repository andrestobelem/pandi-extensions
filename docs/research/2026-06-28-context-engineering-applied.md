---
# Context Engineering, Applied: Mapping the Research onto Our Extensions

> **Status: ANALYSIS.** Companion to `2026-06-28-context-engineering-focus.md`. Reframes
> that research as a concrete audit of the extensions in this package: what each lever
> already implements, where the gaps are, and which fixes earn their place. No code is
> changed by this document; it is the "think deeply" deliverable that precedes any plan.

---

## 1. The core reframe

The research reframes context as a **finite attention budget**, not a bucket to fill. Four
concrete failure modes drive everything else:

- **Lost in the middle** — models attend to the start/end of context, neglect the middle (U-curve).
- **Context rot** — reliability decays as raw input grows, even on trivial tasks.
- **Distraction** — a single off-topic-but-similar sentence pulls attention off task.
- **Instruction-following decay** — obedience to rules falls with length, separable from retrieval.

The striking finding for *this* package: **most of the paper's mitigations already exist here
as runtime mechanisms.** The architecture is, in effect, "context engineering operationalized."
The value is (a) recognizing that explicitly and (b) closing six or seven targeted gaps.

---

## 2. What is already implemented (research lever → extension)

| Research lever | Where it lives | Evidence in code |
|---|---|---|
| External memory / offloading (§3b, MemGPT) | `pi-local-memory` | Injects `MEMORY.md` capped (200 lines/25 KB); topic files are **listed but read on demand** = textbook just-in-time |
| Just-in-time retrieval (§3c) | `pi-dynamic-workflows` + memory | Cheap scout (`git ls-files`/grep/glob), references + on-demand load, `writeArtifact` moves bulk out of chat |
| Small tool budget (§3d, LongFuncEval 7–85%) | workflow personas | `READ_ONLY_AGENT_TOOLS = [read, grep, find, ls]` + `--no-extensions` by default (unless `includeExtensions:true`) |
| Isolate-for-read / single-thread-for-write (§3d, Cognition↔Anthropic) | read-only personas + synthesis-as-judge | explore/reviewer/researcher are read-only; the orchestrator compresses findings |
| Recitation / re-anchor the goal (§3e, Manus) | `pi-goal` + `pi-loop` | Stable mold re-injected each iteration; `successCriteria` recorded ONCE as definition-of-done; progress log **bounded** (anti self-mimicry) |
| Trajectory + adversarial eval (§4, τ-bench) | `pi-goal` independent verifier | Skeptical read-only verifier judges against criteria with evidence, not intuition |
| Architecture-to-topology, not fashion (§3d) | Ultracode router + Contract Gate | Trivial gate avoids over-orchestration; Contract Gate synthesizes a contract before escalating |
| Near-threshold compaction (§3b) | `pi-auto-compact` | Relative edge-trigger at 30%; re-arms from post-compaction % to avoid looping; footer bar = budget gauge |
| Authority separation (§3a) | `pi-local-memory` | Durable directives go to the system channel (trusted content, written by `remember`/human) |

---

## 3. Highest-value gaps (prioritized)

### 3.1 Recoverable compaction — the strongest gap (§3b)

`pi-auto-compact` fires `ctx.compact()` (a harness summary) **without coupling to
memory/artifacts**. The paper is explicit: recursive summarization can drop a fact you later
need; *preserve the raw externally so compaction is recoverable, not destructive.* The 30%
threshold is aggressive and good for the attention budget, but it amplifies cascading-error
risk. Fix: snapshot key state to `.pi/memory` or a run artifact before compacting (or prompt
the agent to do so).

### 3.2 Tool-result clearing as a cheaper lever than full compaction (§3b)

The paper distinguishes *tool-result clearing* (drop bulky consumed payloads, keep the
decision) from full *compaction*. We only have compaction at 30%. An intermediate lever that
clears digested tool outputs would relieve pressure without the cascade risk of summarization.
Complementary to 3.1.

### 3.3 Position-aware synthesis prompts (§2, lost-in-the-middle)

When a workflow's synthesis step receives N branch outputs, put **task + criteria at the start
AND the end** of the synthesis prompt, and reorder the strongest evidence to the edges. Worth
codifying in synthesis prompts and pattern scaffolds — cheap, directly counters the U-curve.

### 3.4 Stable KV-cache prefix in workflows (§3e, Manus + prompt caching)

Keep subagent prompt prefixes stable, push volatile/per-item content to the end, and avoid
`Date.now()`/`Math.random()` early. This matters for two reasons: it protects the provider
cache, and it determines whether a call is cached for `resume` (the content-address cache
journal). Codify "stable prefix" guidance in prompt construction.

### 3.5 Authority guard on memory (§3a, anti-injection)

`remember` writes to the system channel (currently trusted). Add an explicit **non-goal**:
never ingest untrusted tool/retrieved content into `.pi/memory`. Cheap defense-in-depth;
delimiters are not a security boundary.

### 3.6 Focus observability (§4: token growth, tool-error rate, trajectory)

The auto-compact bar (budget gauge) and the goal progress log already exist. **The gap:**
extend observability to **workflow runs** — capture per-step token growth, tool-error rate,
and retries as artifacts, in the spirit of OpenTelemetry GenAI spans. This is the paper's
"measure focus live."

### 3.7 NoLiMa-style evals (§4: do not rely on literal NIAH)

Integration suites verify behavior; the goal verifier is already evidence-based (non-lexical).
Minor opportunity: when adding context evals, gate on **non-lexical needles + distractors**,
not literal matches.

---

## 4. Recommendation

The two highest-ROI, low-risk items are **3.1 (recoverable compaction)** and **3.3
(position-aware synthesis)** — they attack the paper's two central failure modes (compaction
cascade + lost-in-the-middle) with surgical changes to extensions that are already well
understood. Suggested order: plan 3.1 first (it spans `pi-auto-compact` + memory/
artifacts and deserves a design pass), then do 3.3 as a contained follow-up.

---

## 5. Implementation status

> **Status: IMPLEMENTED.** All seven prioritized gaps shipped as separate atomic commits,
> each verified against the full `npm test` gate (typecheck + eslint + prettier + markdownlint
> + integration). Each change is surgical and additive — no breaking change to a public
> contract — in line with the "complexity must earn its place" ethos.

| Gap | What shipped | Commit |
|---|---|---|
| 3.1 | Recoverable compaction: snapshot raw transcript before `ctx.compact()` (hooks `session_before_compact`/`session_compact`), pruning + `snapshot`/`snapshots` subcommands, env `PI_AUTO_COMPACT_SNAPSHOT[_KEEP]` | `9caf486` |
| 3.2 | Opt-in tool-result clearing (`clearOldToolResults`) on the `context` hook — cheaper than compaction, ephemeral, fail-safe, default off | `ee01db5` |
| 3.3 | Position-aware synthesis: restate task + criteria at BOTH ends of synthesis scaffolds; both-ends router guidance | `56d1140` |
| 3.4 | Stable KV-cache prefix guidance in subagent prompt construction (guidance/docs only) | `51c318a` |
| 3.5 | Authority guard on `remember`: anti-injection non-goal (never ingest untrusted content; delimiters are not a security boundary) | `0d2d18e` |
| 3.6 | Per-run focus-metrics artifacts (`metrics.json`/`metrics.md`): token growth, tool-error rate, retries — folded from each subagent's JSON-mode stdout | `8fe6c8a` |
| 3.7 | NoLiMa-style non-lexical eval primitive (`eval-needle.mjs`): non-lexical needle + lexical-lure distractors, never gate on the literal needle string | `900650b` |

Supporting change: a chat-export helper (`scripts/export-chat.mjs`, commit `2f56776`) writes
session HTML into `.pi/chats/`, and `.gitignore`/`.prettierignore` now ignore stray root
`pi-session-*.html` exports so the format gate stays green.
