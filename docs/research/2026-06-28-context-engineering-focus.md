# Context Engineering: Keeping an LLM & Agent Harness in Focus

> **Status: FINAL.** Revised to address external review. Vendor/self-reported figures and disagreements are flagged `[UNVERIFIED]` or `[CONTESTED]`. Where the original draft cited unresolvable (future-dated) arXiv IDs, those specific numbers have been removed. Internal "research-branch agreement" has been replaced with counts of distinct external sources. Coverage gaps named by the reviewer (prompt compression, model-level context extension, injection defenses, advanced RAG, KV-cache eviction, eval breadth) have been added with verified sources. See **§8 Confidence & caveats**.

---

## 1. Executive summary

**Context engineering is the discipline of curating *all* the tokens a model sees.** This includes system prompt, tool definitions, message history, retrieved data, and environment state—curated down to the smallest high-signal set, rather than maximizing what you cram into a large window (Anthropic, "Effective context engineering for AI agents," Sep 29 2025 — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).

**The core reframing:** context is a finite "attention budget," not a bucket.

**Empirically, recall and reasoning reliability degrade as input length grows** — a phenomenon practitioners call "context rot" — even when the task is held constant. The *precise mechanism is debated* (see §2). Self-attention's roughly O(n²) compute/memory cost is often invoked as an intuition for why long contexts are harder, but that is a *cost* property of attention, not an established *cause* of recall loss; treat it as metaphor, not mechanism.

**Why focus degrades (the through-line across the evidence):**

- **Position bias.** Models attend best to the *start and end* of context and worst to the *middle* — a U-shaped curve ("Lost in the Middle," Liu et al., TACL 2024 — https://arxiv.org/abs/2307.03172). The position effect is independently observed in RULER, NoLiMa, and Chroma's Context Rot study.
- **Length-driven decay.** Reliability falls as raw input grows, even on trivial tasks, across 18 models (GPT-4.1, Claude 4, Gemini 2.5, Qwen3 variants, etc.) (Chroma "Context Rot," Jul 14 2025 — https://www.trychroma.com/research/context-rot). This is corroborated by NoLiMa, RULER, and "Context Length Alone Hurts…".
- **Distraction.** Irrelevant-but-similar tokens — even a *single* off-topic sentence — pull attention away from the task (Shi et al., GSM-IC — https://arxiv.org/abs/2302.00093).

**Practical consequence:** keep the working context small and high-signal, place critical material at the edges, retrieve just-in-time, isolate noisy work, and measure focus at realistic lengths rather than trusting advertised windows.

---

## 2. How focus fails (mechanisms)

| Mechanism | What happens | Primary evidence |
|---|---|---|
| **Lost in the middle (position bias)** | Multi-doc QA & key-value retrieval accuracy is highest when evidence is at the beginning/end, drops "significantly" in the middle — sometimes below the closed-book baseline; *long-context variants were not reliably better.* | Liu et al. — https://arxiv.org/abs/2307.03172 / https://aclanthology.org/2024.tacl-1.9/ |
| **Context rot (length decay)** | Performance "becomes less reliable as input length grows," even on controlled tasks, across GPT-4.1, Claude 4, Gemini 2.5, Qwen3 variants. In LongMemEval, ~113k-token full prompts scored *worse* than ~300-token focused prompts. | Chroma — https://www.trychroma.com/research/context-rot |
| **Effective ≪ advertised window** | RULER's "effective length" (threshold ≈ Llama-2-7B@4K, 85.6% over 13 tasks) shows many models fall below their claimed window; vanilla NIAH "can hide major degradation." | RULER, Hsieh et al. — https://arxiv.org/abs/2404.06654 |
| **Latent (non-lexical) retrieval collapse** | When question/needle lexical overlap is removed, 10–11 of ~13 long-context models drop below 50% of short-context baseline at 32K; GPT-4o 99.3%→69.7%. | NoLiMa, Modarressi et al., ICML 2025 — https://arxiv.org/abs/2502.05167 |
| **Distraction by irrelevant context** | One irrelevant sentence cut code-davinci-002 CoT from 95%→72.4%; lexical/entity overlap with the distractor mattered more than magnitude. Self-consistency (20 samples) recovered to 88.1%. | Shi et al., GSM-IC — https://arxiv.org/abs/2302.00093 |
| **Context distraction in RAG** | Answer quality rises then *declines* as retrieved chunks increase; the late drop is attributed to retrieved *hard negatives*. Even one distractor lowers performance; four compound it. | OP-RAG — https://arxiv.org/abs/2409.01666; "LC LLMs Meet RAG" — https://arxiv.org/abs/2410.05983; Chroma (ibid.) |
| **Length hurts even with perfect retrieval** | Degradation as input grows *even when all relevant info is present* — pruning is a focus lever independent of recall. | "Context Length Alone Hurts…" — https://arxiv.org/abs/2510.05381 `[UNVERIFIED magnitude — summary only]` |
| **Attention sinks / recency** | Autoregressive models route large attention mass to the first ~4 tokens regardless of meaning (a softmax artifact); evicting them collapses fluency. Explains why the *very start* of context steers strongly and why naive sliding windows fail. | StreamingLLM, Xiao et al. — https://arxiv.org/abs/2309.17453 |
| **Instruction-following decays with length (distinct from retrieval)** | Most models' instruction-following declines as input grows, especially past 16k/32k tokens, with stability also worsening — separable from "did it retrieve." | LIFBench, ACL 2025 — https://aclanthology.org/2025.acl-long.803/; IFEval — https://arxiv.org/abs/2311.07911 |
| **Self-mimicry / few-shot drift** | Overly uniform/repetitive history makes the model imitate its own past pattern instead of reasoning about current state. | Manus — https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus |

**Mechanism vs. measurement caveat `[CONTESTED/INTERPRETED]`.** Context rot, lost-in-the-middle, and NoLiMa *measure* degradation. The underlying cause—whether positional encoding, attention dilution, or softmax mass allocation—is partly inferred. StreamingLLM gives the most direct mechanistic account but explains streaming/eviction, not all middle-context loss. Whether attention-sink behavior and middle-context neglect are the *same* phenomenon remains **open**.

**Model-level mitigation (context extension).** Length decay is partly a *training-length* artifact: RoPE-based models extrapolate poorly past their trained window. **Position Interpolation** (Chen et al. — https://arxiv.org/abs/2306.15595) and **YaRN** (Peng et al. — https://arxiv.org/abs/2309.00071) rescale rotary position embeddings to extend the usable window with modest fine-tuning. Important caveat: these extend the *trained* length and reduce extrapolation failure, but do **not** by themselves eliminate lost-in-the-middle or context-rot degradation. Effective length still trails the extended window (RULER).

---

## 3. Techniques by layer

### 3a. Context construction (prompt/system, placement, structure, signal-to-noise)

- **Position-aware layout.** Put task-critical material (instructions, the actual question, the single most relevant doc) at the **start and/or end**, never buried mid-context — directly counters the U-shape (Liu et al.). Anchoring durable directives at the *very first tokens* also exploits the attention-sink structure (StreamingLLM).
- **Instructions-first vs. query-at-end `[CONTESTED — reconcilable]`.** OpenAI's guidance: put instructions at the *beginning* (https://help.openai.com/en/articles/6654000-best-practices-for-prompt-engineering-with-the-openai-api). Anthropic's guidance for 20k+ tokens: put large documents at the *top* and the query at the *end*, reporting up to **+30%** response quality `[UNVERIFIED — Anthropic internal tests]` (https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices). Both exploit primacy/recency; the right choice is **context-length-dependent and should be A/B tested** (short prompt → instructions-first; very long doc → query-at-end).
- **Explicit delimiters / structure.** XML or Markdown tags (`<instructions>`, `<context>`, `<examples>`, `<input>`, `<documents>`) let the model distinguish commands from reference data from user input (Anthropic, OpenAI prompt guides). Anthropic notes this is a *reliability aid, not a hard validator*.
- **Authority separation (security + stability).** Durable behavior goes in the `system`/`developer` channel. **Never place untrusted retrieved/tool content there** (Anthropic mid-conversation system messages — https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages; OpenAI prompt engineering guide).
- **Prompt-injection defenses beyond authority separation.** Delimiters are *not* a security boundary. **Spotlighting** (Hines et al., Microsoft — https://arxiv.org/abs/2403.14720) adds stronger data-marking: *delimiting*, *datamarking* (interleaving a special marker through untrusted text), and *encoding* (e.g., base64), reportedly cutting attack success from >50% to <2% `[author-reported]`. A 2026 follow-up benchmark finds effectiveness is **model-dependent** and insufficient against domain-camouflaged injections (https://arxiv.org/abs/2606.18530) — treat as defense-in-depth, not a guarantee.
- **Quote-extraction step.** Ask the model to extract relevant quotes *before* answering long-document tasks — forces attention-narrowing onto specific spans (Anthropic best-practices & reduce-hallucinations docs).
- **Structured Outputs (JSON Schema).** Prefer strict-mode schema over "please output JSON" to eliminate format-drift (OpenAI Structured Outputs — https://developers.openai.com/api/docs/guides/structured-outputs).
- **Few-shot is double-edged `[CONTESTED]`.** Examples help when zero-shot is unreliable, but **ordering alone can swing accuracy from chance to near-SOTA** (Lu et al., "Fantastically Ordered Prompts" — https://aclanthology.org/2022.acl-long.556/). Calibration improved GPT-3 by up to 30 points (Zhao et al., "Calibrate Before Use" — https://arxiv.org/abs/2102.09690). Default: **start zero-shot**, add a small diverse set only if needed, validate across shuffles. Calibration evidence is strongest for classification; transfer to agentic coding is `[UNVERIFIED]`.
- **Reasoning models:** keep prompts simple/direct, use delimiters, zero-shot first, avoid forcing chain-of-thought (OpenAI reasoning best practices).
- **Explicit "ignore irrelevant information" + aggressive pruning** measurably restored robustness in distraction tests (Shi et al., GSM-IC).

### 3b. Context-window management (compaction, offloading, memory, caching)

LangChain's **write / select / compress / isolate** taxonomy organizes every lever (Lance Martin — https://rlancemartin.github.io/2025/06/23/context_engineering/; https://www.langchain.com/blog/context-engineering-for-agents):

- **Compaction.** Summarize accumulated history into a fresh context block near the token threshold. Claude offers *server-side* automatic compaction with custom summary instructions (https://platform.claude.com/docs/en/build-with-claude/compaction).
- **Compaction is lossy and compounds.** Recursive summarization layers can drop facts you later need. Wu et al.'s book-summarization study found only ~5% of summaries reached near-human quality (https://arxiv.org/abs/2109.10862) — this characterizes *summarization*, not compaction specifically. Treat multi-level compaction as a **cascading-error risk** and preserve raw artifacts externally so compaction is recoverable, not destructive.
- **Prompt compression.** **LLMLingua / LongLLMLingua** (Jiang et al., Microsoft — https://arxiv.org/abs/2310.05736, https://arxiv.org/abs/2310.06839) use a small LM to drop low-information tokens. They report multi-× compression with limited quality loss and, for LongLLMLingua, reduced position bias in long contexts `[author-reported figures]`. Useful when verbose history/retrieved text must stay in-window; lossy, so validate on your task.
- **Tool-result clearing / context editing.** Drop verbose past tool outputs once consumed, keeping the *decision* but not the payload (Anthropic context management — https://claude.com/blog/context-management; cookbook — https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools).
- **Filesystem / external memory.** Write large observations to files; keep only references/paths in-window and re-read on demand. **MemGPT** treats the window like OS main memory, paging between in-context and external store via function calls (Packer et al. — https://arxiv.org/abs/2310.08560). Anthropic's file-backed **Memory tool** does this cross-session (https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool).
- **Recursive/hierarchical summarization.** Summarize chunks, then summarize the summaries (OpenAI "Recursively Summarizing Books," Wu et al. — https://arxiv.org/abs/2109.10862).
- **Memory taxonomy.** CoALA: working + episodic + semantic + procedural memory (https://arxiv.org/html/2309.02427v3). Generative Agents retrieve by **relevance/recency/importance** with reflection-based consolidation (https://arxiv.org/abs/2304.03442). LangGraph splits thread-scoped scratchpads (checkpointers) from cross-thread stores (https://docs.langchain.com/oss/python/langgraph/add-memory).
- **Prompt caching.** Order content `tools → system → messages`; keep stable content first, volatile content last; use ≤4 breakpoints. Anthropic reports up to **~90% cost / ~85% latency reduction** for long prompts `[UNVERIFIED — vendor-reported, favorable conditions]` (https://platform.claude.com/docs/en/build-with-claude/prompt-caching; https://claude.com/blog/prompt-caching).

### 3c. Retrieval & just-in-time context (RAG vs JIT, agentic search)

- **Just-in-time over preloading.** Hold lightweight references (file paths, query IDs, links); load contents at runtime via `glob`/`grep`/`head`/`tail`. Trades latency for "less context pollution and better focus" (Anthropic effective-context-engineering).
- **Cap retrieval depth.** Don't dump top-50; find the OP-RAG sweet spot (often modest k) per dataset (https://arxiv.org/abs/2409.01666).
- **Rerank when precision matters and latency allows.** Retrieve broadly (BM25 + dense), fuse with RRF, then apply a cross-encoder reranker to the top candidates. Reranking is often among the largest precision lifts in retrieval pipelines, but cross-encoders add latency/cost and are not always worth it (BEIR benchmark suite — https://arxiv.org/abs/2104.08663; SBERT retrieve-rerank docs). Anthropic's Contextual Retrieval ablation shows reranking adding further gains on top of contextual embeddings+BM25 (https://www.anthropic.com/engineering/contextual-retrieval).
- **Hybrid lexical+dense, not dense-only.** BM25 remains essential for exact identifiers, rare/domain terms, error codes, symbol names — critical in coding harnesses (BEIR benchmark suite — https://arxiv.org/abs/2104.08663; SBERT retrieve-rerank docs).
- **Contextual Retrieval.** Prepend a short situating description to each chunk before embedding/BM25. Anthropic reports top-20 retrieval *failure* rate reductions: 5.7% → 3.7% (contextual embeddings) → 2.9% (+contextual BM25) → 1.9% (+reranking, ~67% relative reduction) `[vendor-reported]` (https://www.anthropic.com/engineering/contextual-retrieval).
- **Query-side and graph-side RAG patterns** (beyond hybrid+rerank):
  - **HyDE** generates a hypothetical answer document and embeds *that* for zero-shot dense retrieval (Gao et al. — https://arxiv.org/abs/2212.10496).
  - **Query decomposition / rewriting** splits complex questions into sub-queries before retrieval (standard multi-hop recall lever; no single canonical source).
  - **Self-RAG** trains the model to retrieve on demand and critique passages via reflection tokens (Asai et al. — https://arxiv.org/abs/2310.11511); **Corrective RAG (CRAG)** adds a retrieval-quality evaluator that triggers corrective web search/filtering (Yan et al. — https://arxiv.org/abs/2401.15884).
  - **GraphRAG** builds an entity graph + community summaries for global, corpus-level questions (Edge et al., Microsoft — https://arxiv.org/abs/2404.16130).
  - **Late chunking** embeds the full document first, then pools per-chunk, preserving cross-chunk context (Günther et al., Jina — https://arxiv.org/abs/2409.04701).
  - **Reorder retrieved docs to the edges.** Place the strongest chunks at the start/end of the retrieved block to counter lost-in-the-middle (Liu et al.).
- **Route LC vs RAG by query type/cost `[CONTESTED — no universal winner]`.** LC generally beats RAG on QA but RAG helps on dialogue/general queries (Li et al. — https://arxiv.org/abs/2501.01880). Self-Route routes cheaply to RAG and only escalates to LC when needed (https://arxiv.org/abs/2407.16833). Only recent SOTA models hold accuracy beyond 64K tokens (https://arxiv.org/abs/2411.03538).
- **Agentic filesystem search vs vector RAG = scale tradeoff.** Filesystem search wins on *tiny* corpora (full docs fit in context); RAG is faster and scales better at 100–1000 docs (LlamaIndex, Jan 13 2026 — https://www.llamaindex.ai/blog/did-filesystem-tools-kill-vector-search).
- **Evaluate retrieval with realistic distractors + non-lexical needles**, not literal NIAH (NoLiMa, Context Rot).

> *Removed from the draft:* domain-specific finance reranking figures (e.g., Recall@5 / MRR@5 gains) that traced to citations with unresolvable, future-dated arXiv IDs.

### 3d. Harness & agent architecture (tool budget, sub-agents, isolation, orchestration)

**The central architectural debate `[CONTESTED — reconcilable]`:**

- **Cognition: default to single-threaded, linear agents with one continuous trace** (https://cognition.com/blog/dont-build-multi-agents). Two principles: (a) *share full agent traces, not isolated messages*; (b) *actions carry implicit decisions*. Naive fan-out drifts because a subagent receiving only a sub-task message lacks the reasoning that produced it and re-decides divergently. Their 2026 update allows multi-agent *only when writes stay single-threaded* and aux agents are read-only (https://cognition.com/blog/multi-agents-working).
- **Anthropic: orchestrator-worker subagents as parallel *context-compression* filters** — each runs a clean window, explores breadth-first, returns only condensed findings (https://www.anthropic.com/engineering/multi-agent-research-system). Reports **+90.2% over single-agent Opus 4** on an internal research eval. **Cost caveat (corrected):** Anthropic separately reports multi-agent runs consume **~15× the tokens of a typical *chat* interaction** (agents alone are ~4× chat); the multiplier *relative to the single-agent baseline that produced the 90.2% gain* is **not stated** in the source. `[UNVERIFIED — Anthropic internal eval; unlikely to transfer to coding/editing.]`

**Reconciliation:** *Isolate for read/explore* (independent, parallelizable, read-heavy work); *single-thread for write/decide* (interdependent, shared mutating state — typical coding). Match architecture to task topology, not fashion.

**Tool budget (strong, multi-source evidence):**

- **Large flat tool surfaces degrade performance.** LongFuncEval: tool-calling accuracy drops **7%–85% as tool count rises**; answer retrieval degrades **7%–91% as tool responses lengthen** (https://arxiv.org/abs/2505.10570).
- **Retrieve a task-specific tool shortlist.** RAG-MCP: **>50% prompt-token reduction**, tool-selection accuracy **43.13% vs 13.62%** baseline (https://arxiv.org/abs/2505.03275). Caveat: generic IR retrievers underperform on tool retrieval (ToolRet — https://arxiv.org/abs/2503.01763), so measure retrieval quality.
- **On-demand tool discovery.** Anthropic Tool Search keeps a search tool + 3–5 common tools, reports **~85% token reduction**; large multi-server MCP setups waste **~55k tokens** before any work starts (https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool).
- **Build fewer, workflow-shaped, non-overlapping tools** with namespacing and token-efficient outputs (https://www.anthropic.com/engineering/writing-tools-for-agents).
- **Explicit delegation contract** for every subagent: objective, output format, allowed tools/sources, task boundaries (Anthropic multi-agent).
- **Scoped tool allowlists / dynamic selection middleware** restrict tools by role/stage/permission (LangChain Deep Agents — https://docs.langchain.com/oss/python/deepagents/context-engineering) `[line-level Claude Code --allowedTools behavior UNVERIFIED]`.

### 3e. Attention steering & control

- **Recitation / re-anchoring.** Maintain and rewrite a `todo.md` plan each step to push the goal into the high-attention recency zone (Manus — https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus). Gains are reported *qualitatively only*; no controlled ablation `[UNVERIFIED magnitude]`.
- **KV-cache-stable prefix.** Keep prompt prefixes stable and context append-only; avoid timestamps/non-determinism early; use explicit breakpoints (Manus; Anthropic prompt-caching).
- **Tool masking over tool removal.** Constrain availability via logit masking / response prefill / a state machine rather than editing the tool roster (Manus).
- **Keep errors / failed actions / stack traces in context.** Preserving failures updates the model's "beliefs" and steers it away from repeating mistakes (Manus).
- **Inject controlled variation** into repetitive histories to prevent self-mimicry few-shot drift (Manus).
- **Retain attention-sink tokens when truncating/streaming** (~4 initial + recent window) instead of naive sliding-window eviction (StreamingLLM). Caveat: this stabilizes generation but does **not** expand the true window or recover evicted content.
- **KV-cache eviction** (research-grade, model-internal). Beyond StreamingLLM's sink retention, eviction policies keep a bounded cache by scoring token importance: **Scissorhands** (persistence-of-importance — https://arxiv.org/abs/2305.17118), **H2O** (heavy-hitter oracle — https://arxiv.org/abs/2306.14048), and **SnapKV** (end-of-prompt observation window — https://arxiv.org/abs/2404.14469). These cut memory/latency but, like StreamingLLM, *manage* the cache rather than expand the true window or recover evicted content.
- **Inference-time attention steering** (research-grade):
  - **PASTA** reweights a small subset of attention heads toward user-marked spans, no weight changes, reporting ~22% avg accuracy gain for LLaMA-7B across four tasks `[unchecked figure]` (https://arxiv.org/abs/2311.02262).
  - **AutoPASTA** auto-identifies key context to emphasize; +7.95% avg for Llama3-70B-Instruct on open-book QA `[unchecked figure]` (https://arxiv.org/abs/2409.10790).
  - **Activation steering** via instruction vectors added to the residual stream enforces format/length/word-inclusion constraints (Stolfo et al. — https://arxiv.org/abs/2410.12877).
- **Self-consistency sampling** dilutes distraction-induced errors (GSM-IC: 72.4%→88.1% with 20 samples).

---

## 4. Evaluating & observing focus

**Benchmarks (offline):**

| What it measures | Benchmark | Source |
|---|---|---|
| Effective vs advertised window | **RULER** (13 task types; threshold ≈85.6%) | https://arxiv.org/abs/2404.06654 / https://github.com/NVIDIA/RULER |
| Length-driven decay, distractors | **Context Rot** (18 models; sweep length, hold difficulty fixed) | https://www.trychroma.com/research/context-rot |
| Positional sensitivity | **Lost in the Middle** (multi-needle / position-swept) | https://arxiv.org/abs/2307.03172 |
| Non-lexical retrieval | **NoLiMa** (use as acceptance gate; vanilla NIAH = smoke test only) | https://arxiv.org/abs/2502.05167 |
| Instruction-following under length | **IFEval** + **LIFBench** (separates "obeyed rules" from "retrieved") | https://arxiv.org/abs/2311.07911 / https://aclanthology.org/2025.acl-long.803/ |
| Realistic long-context reasoning | **LongBench v2** (503 MCQs; experts 53.7%, best model 50.1%, o1-preview 57.7%) | https://arxiv.org/abs/2412.15204 |
| Agent trajectory + final state | **τ-bench** (`pass^k`, final-state grading), **TRAJECT-Bench** (tool selection/args/order) | https://openreview.net/forum?id=roNSXZpUDN / https://arxiv.org/html/2510.04550v2 |

**Observability (online):**

- **OpenTelemetry GenAI spans** define a standard vocabulary: `invoke_agent` (parent) → child `chat` (LLM) and `execute_tool`, plus `plan` and `invoke_workflow`. Chart per-step token growth, tool-error rate, and retries to watch focus degrade live (https://github.com/open-telemetry/semantic-conventions-genai/.../gen-ai-agent-spans.md). Status is still "Development"; content capture (prompts/args) is opt-in.
- **Report model + harness together, with traces/cost/validator outputs logged** — harness configuration materially changes scores (HAL — https://github.com/princeton-pli/hal-harness).

**Evaluation recipe (branch 7):** Run RULER at your target length to find the cliff, then cap inputs below it → re-test with realistic lengths, NoLiMa-style non-lexical needles, and distractors → layer IFEval-style constraint checks → score trajectories (not just final answers) → emit OTel spans → pin/version the harness.

---

## 5. Practical playbook / decision guide

**Defaults (high confidence — corroborated across ≥2 branches):**

1. **Treat context as a scarce attention budget.** Curate to the smallest high-signal set; start minimal, add only what's needed.
2. **Place critical instructions/evidence at the edges (start and end), never the middle.**
3. **Budget to *measured effective length* (RULER), not the advertised window.**
4. **Retrieve just-in-time** (references + on-demand load) rather than preloading.
5. **Cap retrieval depth and always rerank**; use hybrid lexical+dense.
6. **Default to a single-threaded linear agent** for interdependent/coding work; **isolate subagents only for parallel, read-heavy exploration** (and accept the token cost).
7. **Keep a small, non-overlapping core toolset (≈3–5) + tool search**; return token-efficient outputs.
8. **Manage the window** with compaction, tool-result clearing, and external memory as runs lengthen.
9. **Re-anchor the goal** (recitation/`todo.md`) and **keep a stable cache prefix**; mask tools rather than removing them.
10. **Measure focus** with non-lexical needles + distractors and **trajectory-level** agent scoring; trace with OTel.

**Decision quick-reference:**

| Situation | Recommendation |
|---|---|
| Long single doc (20k+) | Documents-top, query-at-end; quote-extraction step |
| Short prompt | Instructions-first |
| Large repo / corpus | JIT/agentic search (small) or RAG (scale); hybrid + rerank |
| Parallel, read-only research | Orchestrator-worker subagents with explicit contracts |
| Interdependent edits / coding | Single continuous trace + compaction |
| Large/MCP tool library | Core toolset + tool search/retrieval |
| Long agent loop accumulating noise | Tool-result clearing + external memory + recitation |

**Anti-patterns (evidence-backed):**

- Trusting a big advertised window to mean uniform attention (RULER, Context Rot).
- Dumping all retrieved chunks / all tool schemas (OP-RAG distraction; LongFuncEval).
- Burying instructions in the middle (Lost in the Middle).
- Putting untrusted retrieved/tool content in the system channel (injection/authority drift).
- Scrubbing errors from context (removes recovery signal — Manus).
- Mutating tool definitions mid-loop (busts cache, dangling references — Manus).
- Naive sliding-window KV eviction that drops sink tokens (StreamingLLM).
- Using vanilla single-needle NIAH as your only long-context eval — it hides real degradation; gate on NoLiMa-style non-lexical needles + RULER (NoLiMa, RULER, Context Rot).

---

## 6. Evidence & sources (consolidated)

Deduplicated, grouped by theme. Vendor/self-reported figures are flagged `[UNVERIFIED]` in-text.

### Failure modes & mechanisms
- Lost in the Middle — Liu et al., TACL 2024 — https://arxiv.org/abs/2307.03172
- Context Rot — Chroma, 2025 — https://www.trychroma.com/research/context-rot
- RULER — Hsieh et al. — https://arxiv.org/abs/2404.06654 · https://github.com/NVIDIA/RULER
- NoLiMa — Modarressi et al., ICML 2025 — https://arxiv.org/abs/2502.05167
- Distraction (GSM-IC) — Shi et al. — https://arxiv.org/abs/2302.00093
- OP-RAG — https://arxiv.org/abs/2409.01666 · LC LLMs Meet RAG — https://arxiv.org/abs/2410.05983 · Context length alone hurts — https://arxiv.org/abs/2510.05381
- StreamingLLM / attention sinks — Xiao et al. — https://arxiv.org/abs/2309.17453
- LIFBench — https://aclanthology.org/2025.acl-long.803/ · IFEval — https://arxiv.org/abs/2311.07911

### Model-level context extension
- Position Interpolation — Chen et al. — https://arxiv.org/abs/2306.15595 · YaRN — Peng et al. — https://arxiv.org/abs/2309.00071

### Context construction & prompting
- Anthropic, Effective context engineering — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic prompting best practices — https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
- OpenAI prompt engineering — https://help.openai.com/en/articles/6654000-best-practices-for-prompt-engineering-with-the-openai-api
- OpenAI Structured Outputs — https://developers.openai.com/api/docs/guides/structured-outputs
- Fantastically Ordered Prompts — Lu et al. — https://aclanthology.org/2022.acl-long.556/ · Calibrate Before Use — Zhao et al. — https://arxiv.org/abs/2102.09690

### Prompt-injection defenses
- Spotlighting — Hines et al., Microsoft — https://arxiv.org/abs/2403.14720

### Window management, compaction, memory, caching
- LangChain context engineering — https://www.langchain.com/blog/context-engineering-for-agents · https://rlancemartin.github.io/2025/06/23/context_engineering/
- Anthropic context management — https://claude.com/blog/context-management · compaction — https://platform.claude.com/docs/en/build-with-claude/compaction
- LLMLingua / LongLLMLingua — https://arxiv.org/abs/2310.05736 · https://arxiv.org/abs/2310.06839
- MemGPT — Packer et al. — https://arxiv.org/abs/2310.08560 · Recursive summarization — Wu et al. — https://arxiv.org/abs/2109.10862
- CoALA — https://arxiv.org/html/2309.02427v3 · Generative Agents — https://arxiv.org/abs/2304.03442 · LangGraph memory — https://docs.langchain.com/oss/python/langgraph/add-memory
- Anthropic prompt caching — https://platform.claude.com/docs/en/build-with-claude/prompt-caching

### Retrieval / RAG
- Anthropic Contextual Retrieval — https://www.anthropic.com/engineering/contextual-retrieval · BEIR — https://arxiv.org/abs/2104.08663
- HyDE — https://arxiv.org/abs/2212.10496 · Self-RAG — https://arxiv.org/abs/2310.11511 · CRAG — https://arxiv.org/abs/2401.15884 · GraphRAG — https://arxiv.org/abs/2404.16130 · Late chunking — https://arxiv.org/abs/2409.04701
- LC vs RAG — https://arxiv.org/abs/2501.01880 · Self-Route — https://arxiv.org/abs/2407.16833 · long-context limits — https://arxiv.org/abs/2411.03538
- Filesystem vs vector search — LlamaIndex — https://www.llamaindex.ai/blog/did-filesystem-tools-kill-vector-search

### Harness & agent architecture
- Cognition, Don't build multi-agents — https://cognition.com/blog/dont-build-multi-agents · update — https://cognition.com/blog/multi-agents-working
- Anthropic multi-agent research system — https://www.anthropic.com/engineering/multi-agent-research-system
- LongFuncEval — https://arxiv.org/abs/2505.10570 · RAG-MCP — https://arxiv.org/abs/2505.03275 · ToolRet — https://arxiv.org/abs/2503.01763
- Anthropic Tool Search — https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool · Writing tools for agents — https://www.anthropic.com/engineering/writing-tools-for-agents
- LangChain Deep Agents — https://docs.langchain.com/oss/python/deepagents/context-engineering

### Attention steering & KV-cache
- Manus context engineering — https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- Scissorhands — https://arxiv.org/abs/2305.17118 · H2O — https://arxiv.org/abs/2306.14048 · SnapKV — https://arxiv.org/abs/2404.14469
- PASTA — https://arxiv.org/abs/2311.02262 · AutoPASTA — https://arxiv.org/abs/2409.10790 · Activation steering — https://arxiv.org/abs/2410.12877

### Evaluation & observability
- LongBench v2 — https://arxiv.org/abs/2412.15204 · τ-bench — https://openreview.net/forum?id=roNSXZpUDN · TRAJECT-Bench — https://arxiv.org/html/2510.04550v2
- OpenTelemetry GenAI agent spans — https://github.com/open-telemetry/semantic-conventions-genai · HAL harness — https://github.com/princeton-pli/hal-harness

---

## 7. Open questions & coverage gaps

- **Mechanism vs measurement.** Whether lost-in-the-middle, context rot, and attention-sink behavior share one cause (positional encoding vs. attention dilution vs. softmax mass allocation) is unresolved. StreamingLLM explains streaming/eviction, not all middle-context loss.
- **Does recitation actually work?** Manus's "re-anchor the goal / rewrite todo.md" is reported only qualitatively; no controlled ablation quantifies the gain.
- **Multi-agent cost/benefit transfer.** Anthropic's +90.2% is a research-retrieval eval; the cost multiplier vs the single-agent baseline that produced the 90.2% gain is unstated, and transfer to write-heavy coding is unknown.
- **LC vs RAG has no universal winner.** Routing depends on query type, corpus scale, and model generation — measure per system.
- **Eval breadth.** This report leans on RULER / NoLiMa / Context Rot / LongBench v2; the reviewer notes HELMET, ∞Bench (InfiniteBench), Michelangelo, BABILong would broaden the acceptance suite (not yet integrated here).
- **Provenance gap.** One research branch (attention steering) was partly corrupted; §3e steering magnitudes (PASTA/AutoPASTA) are cited but were not independently re-verified.

---

## 8. Confidence & caveats

**Solid (spot-checked against primary sources by the adversarial reviewer):** the §2 mechanisms table; Context Rot, NoLiMa, Anthropic Contextual Retrieval, Anthropic multi-agent +90.2%, and the LlamaIndex filesystem-vs-RAG findings; the Cognition-vs-Anthropic architectural reconciliation in §3d.

**Corrected during review (were wrong/over-claimed in the first draft):** the multi-agent "15× cost" baseline conflation (15× is vs *chat*, not vs single-agent); the executive-summary O(n²) *causal* framing (reframed as observed correlation); "Always rerank / single largest precision lift" (softened to "when precision matters and latency allows"); unresolvable future-dated finance arXiv IDs and their numbers (removed); "cited by N branches" (replaced with distinct external sources); "18 frontier models" → "18 models".

**Shaky / `[UNVERIFIED]` (plausible, properly cited, not independently re-checked here):** RULER's 85.6%/13-task threshold; PASTA ~22% / AutoPASTA +7.95%; RAG-MCP 43.13% vs 13.62%; LongFuncEval 7%–85%; GSM-IC 95%→72.4%→88.1%; vendor caching "~90% cost / ~85% latency"; Anthropic "+30%" long-doc layout figure.

**Provenance of this document:** produced by a 4-stage dynamic workflow (7 read-only web-research branches → synthesis → adversarial review → revision). The auto-generated final-revision artifact hit the subagent output cap and truncated mid-§4, so §1–§3e are the reviewer-corrected revision, §4–§5 are restored from the synthesis draft, and §6–§8 were assembled from the gathered evidence and the reviewer's confidence notes. Run: `2026-06-28T10-04-04-932Z-drafts-context-engineering-focus-6c131aa1`.
